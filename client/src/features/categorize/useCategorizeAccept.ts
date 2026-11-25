/**
 * The Categorize accept flow: optimistic filing, the undo toast and the
 * server's answer. Every request is built from the queue data the page shows
 * (explicit pairs for rows and for "accept all", one server-resolved bundle
 * for a card). A failure restores exactly the optimistically hidden rows and
 * refetches the queue; a bundle whose count moved (409) also drops the
 * optimistic card so the fresh count shows.
 *
 * Undo and Z reverse the LAST thing the person did (by press order, not by
 * response order); pressing Undo while its request is still in flight waits for
 * the answer. A skip is permanent and budget-wide, so it is only sent when its
 * toast runs out or another action begins; Undo inside that window cancels it,
 * and leaving the page cancels it too (the row simply comes back).
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
import { beginTarget, confirmTarget, failTarget, undoInChunks, undoOutcome, type UndoTarget } from './undo.logic';

/** The mock's undo window; a pending skip is sent when it runs out. */
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
  /** Leave the row uncategorized: pending for the toast window, then permanent for the whole budget. */
  skipRow: (row: CategorizeQueueRow) => boolean;
  acceptBundle: (bundle: CategorizeBundle, knownRows: readonly CategorizeQueueRow[]) => Promise<boolean>;
  acceptAll: (bundles: readonly CategorizeBundle[]) => Promise<boolean>;
  /** Reverse the last action; resolves to the transactions that came back to the queue. */
  undoLast: () => Promise<string[]>;
  dismissError: () => void;
}

interface PendingSkip {
  row: CategorizeQueueRow;
  item: FiledItem;
  seq: number;
  timer: ReturnType<typeof setTimeout>;
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
  const seqRef = useRef(0);
  /** The target Undo reverses, kept in step with `state.undoable` (a ref so async code reads it fresh). */
  const targetRef = useRef<UndoTarget | null>(null);
  /** Settles when the newest accept request has answered: Undo waits for it. */
  const settledRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingSkip = useRef<PendingSkip | null>(null);
  const undoRunning = useRef(false);

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

  // Leaving the page cancels a pending skip: the row was never sent, so it is
  // simply back in the queue next time. Nothing permanent happens by leaving.
  useEffect(
    () => () => {
      if (pendingSkip.current) clearTimeout(pendingSkip.current.timer);
      pendingSkip.current = null;
    },
    [],
  );

  const setTarget = (target: UndoTarget | null) => {
    targetRef.current = target;
    reduce({ type: 'setUndoable', target });
  };

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

  /** The pending skip goes out now (its window ended, or the person moved on). */
  const commitPendingSkip = (): void => {
    const pending = pendingSkip.current;
    if (!pending || !budgetId) return;
    pendingSkip.current = null;
    clearTimeout(pending.timer);
    if (targetRef.current?.seq === pending.seq) setTarget(null);
    reduce({ type: 'skipSending', item: pending.item });
    skip({ budgetId, transactionId: pending.row.transaction_id })
      .unwrap()
      .then(
        () => reduce({ type: 'skipDone', requestId: pending.item.transactionId }),
        (err: unknown) => {
          reduce({
            type: 'failed',
            error: apiErrorMessage(err, t('error.skip')),
            requestIds: [pending.item.transactionId],
          });
          queueRefetch();
        },
      );
  };

  const beginAction = (label: string, ids: string[]): number => {
    seqRef.current += 1;
    setTarget(beginTarget(seqRef.current, 'accept', label, ids));
    return seqRef.current;
  };

  /** The answer for action `seq`: is it still the latest press? Fills in the target if so. */
  const answered = (seq: number, transactionIds: string[]): boolean => {
    const latest = targetRef.current?.seq === seq;
    const next = confirmTarget(targetRef.current, seq, transactionIds);
    if (next !== targetRef.current) setTarget(next);
    return latest;
  };

  const failed = (seq: number) => {
    const next = failTarget(targetRef.current, seq);
    if (next !== targetRef.current) setTarget(next);
  };

  /**
   * File explicit pairs. A single row (keyboard filing) may overlap another
   * request so quick presses are never dropped; a batch is exclusive.
   */
  const runItems = (
    items: CategorizeDecisionItem[],
    filed: FiledItem[],
    label: string,
    { exclusive = false }: { exclusive?: boolean } = {},
  ): Promise<boolean> => {
    if (!budgetId || items.length === 0) return Promise.resolve(false);
    if (exclusive && inFlight.current) return Promise.resolve(false);
    commitPendingSkip();
    if (exclusive) inFlight.current = true;
    const requestIds = filed.map((item) => item.transactionId);
    const seq = beginAction(label, requestIds);
    reduce({ type: 'start', items: filed });
    const request = (async () => {
      try {
        const result = await accept({ budgetId, items }).unwrap();
        const ids = result.items.map((item) => item.transaction_id);
        reduce({ type: 'succeeded', transactionIds: ids, requestIds, label, showToast: answered(seq, ids) });
        return true;
      } catch (err) {
        failed(seq);
        reduce({ type: 'failed', error: apiErrorMessage(err, t('error.accept')), requestIds });
        queueRefetch();
        return false;
      } finally {
        if (exclusive) inFlight.current = false;
      }
    })();
    settledRef.current = request;
    return request;
  };

  const fileRow = (row: CategorizeQueueRow, suggestion: CategorizeSuggestion): Promise<boolean> => {
    const filed = filedItem(row, suggestion.category_id, suggestion.category_name);
    return runItems(
      [{ transaction_id: row.transaction_id, category_id: suggestion.category_id }],
      [filed],
      filedLabel(filed),
    );
  };

  const pickCategory = (row: CategorizeQueueRow, category: PickedCategory): Promise<boolean> => {
    const filed = filedItem(row, category.id, category.label);
    return runItems(
      [{ transaction_id: row.transaction_id, category_id: category.id }],
      [filed],
      filedLabel(filed),
    );
  };

  const skipRow = (row: CategorizeQueueRow): boolean => {
    if (!budgetId) return false;
    commitPendingSkip();
    const item = filedItem(row, '', '');
    const label = skippedLabel(item);
    seqRef.current += 1;
    const seq = seqRef.current;
    setTarget(beginTarget(seq, 'skip', label, [row.transaction_id]));
    reduce({ type: 'skipStarted', item, label });
    pendingSkip.current = { row, item, seq, timer: setTimeout(commitPendingSkip, UNDO_TOAST_MS) };
    return true;
  };

  const acceptBundle = (bundle: CategorizeBundle, knownRows: readonly CategorizeQueueRow[]): Promise<boolean> => {
    if (!budgetId || inFlight.current) return Promise.resolve(false);
    commitPendingSkip();
    inFlight.current = true;
    markGone(bundle.bundle_key, true);
    const filed = knownRows.map((row) =>
      filedItem(row, bundle.suggestion.category_id, bundle.suggestion.category_name),
    );
    const requestIds = filed.map((item) => item.transactionId);
    const label = bundleToastLabel(bundle);
    const seq = beginAction(label, []);
    reduce({ type: 'start', items: filed });
    const request = (async () => {
      try {
        const result = await accept({
          budgetId,
          bundleKey: bundle.bundle_key,
          expectedCount: bundle.count,
        }).unwrap();
        const ids = result.items.map((item) => item.transaction_id);
        reduce({ type: 'succeeded', transactionIds: ids, requestIds, label, showToast: answered(seq, ids) });
        return true;
      } catch (err) {
        const changed = isBundleChanged(err);
        failed(seq);
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
    })();
    settledRef.current = request;
    return request;
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

  const acceptAll = (bundles: readonly CategorizeBundle[]): Promise<boolean> => {
    if (!budgetId || inFlight.current || bundles.length === 0) return Promise.resolve(false);
    commitPendingSkip();
    inFlight.current = true;
    setGoneBundleKeys(new Set(bundles.map((bundle) => bundle.bundle_key)));
    const seq = beginAction('', []);
    reduce({ type: 'start', items: [] });
    const accepted: CategorizeDecisionItem[] = [];
    const finish = (error?: string) => {
      const ids = accepted.map((item) => item.transaction_id);
      if (ids.length > 0) {
        const label = filedCountLabel(ids.length);
        reduce({ type: 'succeeded', transactionIds: ids, requestIds: [], label, showToast: answered(seq, ids), error });
      } else {
        failed(seq);
        reduce({ type: 'failed', error: error ?? t('error.accept'), requestIds: [] });
      }
    };
    const request = (async () => {
      try {
        const items: CategorizeDecisionItem[] = [];
        for (const bundle of bundles) items.push(...(await bundleItems(bundle)));
        if (items.length === 0) {
          finish(t('error.accept'));
          setGoneBundleKeys(new Set());
          queueRefetch();
          return false;
        }
        for (let i = 0; i < items.length; i += ACCEPT_BATCH) {
          const result = await accept({ budgetId, items: items.slice(i, i + ACCEPT_BATCH) }).unwrap();
          accepted.push(...result.items);
        }
        finish();
        return true;
      } catch (err) {
        finish(apiErrorMessage(err, t('error.accept')));
        setGoneBundleKeys(new Set());
        queueRefetch();
        return false;
      } finally {
        inFlight.current = false;
      }
    })();
    settledRef.current = request;
    return request;
  };

  const undoLast = async (): Promise<string[]> => {
    if (!budgetId) return [];
    // Pressed while the last request is in flight: wait for its answer, never drop the press.
    await settledRef.current;
    const target = targetRef.current;
    if (!target) return [];

    if (target.kind === 'skip') {
      const pending = pendingSkip.current;
      if (!pending || pending.seq !== target.seq) return [];
      clearTimeout(pending.timer);
      pendingSkip.current = null;
      setTarget(null);
      reduce({ type: 'skipCancelled', transactionId: pending.item.transactionId });
      return [pending.item.transactionId];
    }

    if (target.transactionIds.length === 0 || undoRunning.current) return [];
    undoRunning.current = true;
    reduce({ type: 'undoStarted' });
    try {
      const summary = await undoInChunks(target.transactionIds, (chunk) =>
        undo({ budgetId, transactionIds: chunk }).unwrap(),
      );
      const outcome = undoOutcome(summary);
      // What was not reached stays undoable; what the server left alone cannot be undone.
      const rest = summary.remaining.length > 0 ? { ...target, transactionIds: summary.remaining } : null;
      setTarget(rest);
      reduce({
        type: 'undoFinished',
        restoredIds: summary.restored,
        undoable: rest,
        message: outcome.text,
        tone: outcome.tone,
      });
      if (summary.failed) queueRefetch();
      return summary.restored;
    } finally {
      undoRunning.current = false;
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
