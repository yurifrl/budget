/**
 * The Categorize accept flow: optimistic filing, the undo toast and the
 * server's answer. Every request is built from the queue data the page shows
 * (explicit pairs for rows and for "accept all", one server-resolved bundle
 * for a card). A failure restores exactly the optimistically hidden rows and
 * refetches the queue; a bundle whose count moved (409) also drops the
 * optimistic card so the fresh count shows.
 */

import { useEffect, useReducer, useRef, useState } from 'react';

import {
  budgetApi,
  useAcceptCategorizeMutation,
  useSkipCategorizeMutation,
  useUndoCategorizeMutation,
  type CategorizeBundle,
  type CategorizeDecisionItem,
  type CategorizeQueueRow,
  type CategorizeSuggestion,
} from '@/budget/data/api';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useAppDispatch } from '@/state/hooks';

import {
  acceptIdle,
  acceptReducer,
  filedCountLabel,
  filedLabel,
  initialAcceptState,
  skippedLabel,
  type AcceptState,
  type FiledItem,
} from './accept.logic';
import { t } from './i18n';
import { bundleChangedMessage, bundleToastLabel, isBundleChanged, rowSubject, type PickedCategory } from './page.logic';

/** The mock's undo window. */
const UNDO_TOAST_MS = 10_000;
/** The queue contract's page cap; bundle rows page through it. */
const QUEUE_PAGE = 200;
/** The accept contract's per-request cap. */
const ACCEPT_BATCH = 1000;

export interface CategorizeAccept {
  state: AcceptState;
  idle: boolean;
  goneBundleKeys: ReadonlySet<string>;
  /** Bumped when a bundle accept was refused with 409; the view collapses that card. */
  bundleChangeTick: number;
  fileRow: (row: CategorizeQueueRow, suggestion: CategorizeSuggestion) => Promise<boolean>;
  pickCategory: (row: CategorizeQueueRow, category: PickedCategory) => Promise<boolean>;
  /** Leave the row without a category for good (budget-wide skip decision). */
  skipRow: (row: CategorizeQueueRow) => Promise<boolean>;
  acceptBundle: (bundle: CategorizeBundle, knownRows: readonly CategorizeQueueRow[]) => Promise<boolean>;
  acceptAll: (bundles: readonly CategorizeBundle[]) => Promise<boolean>;
  /** Reverse the last accept; resolves to the transactions the server restored. */
  undoLast: () => Promise<string[]>;
  dismissError: () => void;
}

export function useCategorizeAccept({
  budgetId,
  formatMoney,
  queueRefetch,
  queueUpdatedAt,
  queueRowIds,
}: {
  budgetId: string | null;
  formatMoney: (cents: number) => string;
  queueRefetch: () => void;
  /** The queue read's fulfilled timestamp: clears optimistic bundle removals. */
  queueUpdatedAt: number;
  /** The rows the queue read lists now: hidden ids outside it are forgotten. */
  queueRowIds: readonly string[];
}): CategorizeAccept {
  const [accept] = useAcceptCategorizeMutation();
  const [undo] = useUndoCategorizeMutation();
  const [skip] = useSkipCategorizeMutation();
  const storeDispatch = useAppDispatch();
  const [state, reduce] = useReducer(acceptReducer, initialAcceptState);
  const [goneBundleKeys, setGoneBundleKeys] = useState<ReadonlySet<string>>(new Set());
  const [bundleChangeTick, setBundleChangeTick] = useState(0);
  const inFlight = useRef(false);

  const rowIdsRef = useRef(queueRowIds);
  rowIdsRef.current = queueRowIds;
  useEffect(() => {
    setGoneBundleKeys(new Set());
    reduce({ type: 'prune', presentIds: rowIdsRef.current });
  }, [queueUpdatedAt]);

  useEffect(() => {
    if (!state.toast) return;
    const id = setTimeout(() => reduce({ type: 'dismissToast' }), UNDO_TOAST_MS);
    return () => clearTimeout(id);
  }, [state.toast]);

  const markGone = (key: string, gone: boolean) =>
    setGoneBundleKeys((prev) => {
      const next = new Set(prev);
      if (gone) next.add(key);
      else next.delete(key);
      return next;
    });

  const filedItem = (row: CategorizeQueueRow, categoryId: string, categoryName: string): FiledItem => ({
    transactionId: row.transaction_id,
    categoryId,
    categoryName,
    subject: rowSubject(row, formatMoney),
  });

  /**
   * File explicit pairs. A single row (keyboard filing) may overlap another
   * request so quick presses are never dropped; a batch is exclusive.
   */
  const runItems = async (
    items: CategorizeDecisionItem[],
    filed: FiledItem[],
    label: string,
    { exclusive = false }: { exclusive?: boolean } = {},
  ): Promise<boolean> => {
    if (!budgetId || items.length === 0) return false;
    if (exclusive && inFlight.current) return false;
    if (exclusive) inFlight.current = true;
    const requestIds = filed.map((item) => item.transactionId);
    reduce({ type: 'start', items: filed });
    try {
      const result = await accept({ budgetId, items }).unwrap();
      reduce({
        type: 'succeeded',
        transactionIds: result.items.map((item) => item.transaction_id),
        requestIds,
        label,
      });
      return true;
    } catch (err) {
      reduce({ type: 'failed', error: apiErrorMessage(err, t('error.accept')), requestIds });
      queueRefetch();
      return false;
    } finally {
      if (exclusive) inFlight.current = false;
    }
  };

  const fileRow = async (row: CategorizeQueueRow, suggestion: CategorizeSuggestion): Promise<boolean> => {
    const filed = filedItem(row, suggestion.category_id, suggestion.category_name);
    return runItems(
      [{ transaction_id: row.transaction_id, category_id: suggestion.category_id }],
      [filed],
      filedLabel(filed),
    );
  };

  const pickCategory = async (row: CategorizeQueueRow, category: PickedCategory): Promise<boolean> => {
    const filed = filedItem(row, category.id, category.label);
    return runItems(
      [{ transaction_id: row.transaction_id, category_id: category.id }],
      [filed],
      filedLabel(filed),
    );
  };

  const skipRow = async (row: CategorizeQueueRow): Promise<boolean> => {
    if (!budgetId) return false;
    const item = filedItem(row, '', '');
    reduce({ type: 'skipStarted', item });
    try {
      await skip({ budgetId, transactionId: row.transaction_id }).unwrap();
      reduce({ type: 'skipSucceeded', requestId: row.transaction_id, label: skippedLabel(item) });
      return true;
    } catch (err) {
      reduce({ type: 'failed', error: apiErrorMessage(err, t('error.skip')), requestIds: [row.transaction_id] });
      queueRefetch();
      return false;
    }
  };

  const acceptBundle = async (
    bundle: CategorizeBundle,
    knownRows: readonly CategorizeQueueRow[],
  ): Promise<boolean> => {
    if (!budgetId || inFlight.current) return false;
    inFlight.current = true;
    markGone(bundle.bundle_key, true);
    const filed = knownRows.map((row) =>
      filedItem(row, bundle.suggestion.category_id, bundle.suggestion.category_name),
    );
    const requestIds = filed.map((item) => item.transactionId);
    reduce({ type: 'start', items: filed });
    try {
      const result = await accept({
        budgetId,
        bundleKey: bundle.bundle_key,
        expectedCount: bundle.count,
      }).unwrap();
      reduce({
        type: 'succeeded',
        transactionIds: result.items.map((item) => item.transaction_id),
        requestIds,
        label: bundleToastLabel(bundle),
      });
      return true;
    } catch (err) {
      const changed = isBundleChanged(err);
      reduce({
        type: 'failed',
        error: changed ? bundleChangedMessage(err) : apiErrorMessage(err, t('error.accept')),
        requestIds,
      });
      markGone(bundle.bundle_key, false);
      if (changed) setBundleChangeTick((tick) => tick + 1);
      queueRefetch();
      return false;
    } finally {
      inFlight.current = false;
    }
  };

  /** Every row of one bundle, paged at the contract's 200-row cap. */
  const bundleItems = async (bundle: CategorizeBundle): Promise<CategorizeDecisionItem[]> => {
    if (!budgetId) return [];
    const items: CategorizeDecisionItem[] = [];
    for (let offset = 0; offset < bundle.count; offset += QUEUE_PAGE) {
      const page = await storeDispatch(
        budgetApi.endpoints.getCategorizeQueue.initiate(
          { budgetId, bundle: bundle.bundle_key, limit: QUEUE_PAGE, offset },
          { subscribe: false, forceRefetch: true },
        ),
      ).unwrap();
      for (const row of page.rows) {
        items.push({ transaction_id: row.transaction_id, category_id: bundle.suggestion.category_id });
      }
      if (page.rows.length < QUEUE_PAGE) break;
    }
    return items;
  };

  const acceptAll = async (bundles: readonly CategorizeBundle[]): Promise<boolean> => {
    if (!budgetId || inFlight.current || bundles.length === 0) return false;
    inFlight.current = true;
    setGoneBundleKeys(new Set(bundles.map((bundle) => bundle.bundle_key)));
    reduce({ type: 'start', items: [] });
    const accepted: CategorizeDecisionItem[] = [];
    try {
      const items: CategorizeDecisionItem[] = [];
      for (const bundle of bundles) items.push(...(await bundleItems(bundle)));
      if (items.length === 0) {
        reduce({ type: 'failed', error: t('error.accept'), requestIds: [] });
        setGoneBundleKeys(new Set());
        queueRefetch();
        return false;
      }
      for (let i = 0; i < items.length; i += ACCEPT_BATCH) {
        const result = await accept({ budgetId, items: items.slice(i, i + ACCEPT_BATCH) }).unwrap();
        accepted.push(...result.items);
      }
      reduce({
        type: 'succeeded',
        transactionIds: accepted.map((item) => item.transaction_id),
        requestIds: [],
        label: filedCountLabel(accepted.length),
      });
      return true;
    } catch (err) {
      if (accepted.length > 0) {
        reduce({
          type: 'succeeded',
          transactionIds: accepted.map((item) => item.transaction_id),
          requestIds: [],
          label: filedCountLabel(accepted.length),
        });
      }
      reduce({ type: 'failed', error: apiErrorMessage(err, t('error.accept')), requestIds: [] });
      setGoneBundleKeys(new Set());
      queueRefetch();
      return false;
    } finally {
      inFlight.current = false;
    }
  };

  const undoLast = async (): Promise<string[]> => {
    const transactionIds = state.undoable?.transactionIds ?? [];
    if (!budgetId || inFlight.current || transactionIds.length === 0) return [];
    inFlight.current = true;
    reduce({ type: 'undoStarted' });
    try {
      const result = await undo({ budgetId, transactionIds }).unwrap();
      reduce({
        type: 'undoSucceeded',
        transactionIds: result.transaction_ids,
        restored: result.restored,
        skipped: result.skipped.length,
      });
      return result.transaction_ids;
    } catch (err) {
      reduce({ type: 'undoFailed', error: apiErrorMessage(err, t('error.undo')) });
      return [];
    } finally {
      inFlight.current = false;
    }
  };

  return {
    state,
    idle: acceptIdle(state),
    goneBundleKeys,
    bundleChangeTick,
    fileRow,
    pickCategory,
    skipRow,
    acceptBundle,
    acceptAll,
    undoLast,
    dismissError: () => reduce({ type: 'clearError' }),
  };
}
