/**
 * The Categorize accept flow: optimistic filing, the undo toast and the
 * server's answer. Every request is built from the queue data the page shows
 * (explicit pairs for rows and for "accept all", one server-resolved bundle
 * for a card). A failure restores exactly the optimistically hidden rows and
 * refetches the queue; a bundle whose count moved (409) also drops the
 * optimistic card so the fresh count shows.
 *
 * Undo and Z pop a STACK of the visit's actions in key-press order. An accept
 * is undone through the API (waiting for its answer if it is still in flight);
 * a skip is permanent and budget-wide, so it only goes out when ITS OWN 10 s
 * timer ends, no other action sends it, and Undo before then cancels it and its
 * row returns. A sent skip leaves the stack. Leaving the page cancels every
 * pending skip (nothing was sent, the rows simply come back).
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
  pendingSkips,
  topEntry,
  withoutPendingSkips,
  type AcceptAction,
  type AcceptState,
  type FiledItem,
} from './accept.logic';
import { t } from './i18n';
import { bundleChangedMessage, bundleToastLabel, isBundleChanged, rowSubject, type PickedCategory } from './page.logic';
import { undoInChunks, undoOutcome } from './undo.logic';

/** The mock's undo window; a pending skip is sent when ITS timer runs out. */
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
  /** Leave the row uncategorized: pending for 10 s, then permanent for the whole budget. */
  skipRow: (row: CategorizeQueueRow) => boolean;
  /** Cancel one pending skip (its row returns); false when it is not pending any more. */
  cancelSkip: (transactionId: string) => boolean;
  acceptBundle: (bundle: CategorizeBundle, knownRows: readonly CategorizeQueueRow[]) => Promise<boolean>;
  acceptAll: (bundles: readonly CategorizeBundle[]) => Promise<boolean>;
  /** Undo the most recent action; resolves to the transactions that came back to the queue. */
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
  /** The latest state, updated in step with every dispatch so async code reads it fresh. */
  const stateRef = useRef(state);
  const send = (action: AcceptAction) => {
    stateRef.current = acceptReducer(stateRef.current, action);
    reduce(action);
  };
  const [goneBundleKeys, setGoneBundleKeys] = useState<ReadonlySet<string>>(new Set());
  const [bundleChangeTick, setBundleChangeTick] = useState(0);
  const inFlight = useRef(false);
  const seqRef = useRef(0);
  /** Each accept's request, so Undo can wait for the answer of the action it is about to reverse. */
  const requests = useRef(new Map<number, Promise<boolean>>());
  /** The transactions the server accepted for a request. */
  const resultIds = useRef(new Map<number, string[]>());
  /** One timer per pending skip, keyed by its stack entry. */
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const rowIdsRef = useRef(queueRowIds);
  rowIdsRef.current = queueRowIds;
  useEffect(() => {
    setGoneBundleKeys(new Set());
    // A pending skip whose row has left the queue (categorized elsewhere, taken
    // by a bulk accept) is dropped, never sent: there is nothing left to skip.
    const present = new Set(rowIdsRef.current);
    for (const entry of pendingSkips(stateRef.current)) {
      if (present.has(entry.item.transactionId)) continue;
      const timer = timers.current.get(entry.seq);
      if (timer) clearTimeout(timer);
      timers.current.delete(entry.seq);
      send({ type: 'skipDropped', transactionId: entry.item.transactionId });
    }
    send({ type: 'prune', presentIds: rowIdsRef.current });
  }, [queueUpdatedAt]);

  useEffect(() => {
    if (!state.toast) return;
    const id = setTimeout(() => send({ type: 'dismissToast' }), UNDO_TOAST_MS);
    return () => clearTimeout(id);
  }, [state.toast]);

  // Leaving the page cancels every pending skip: none was sent, so the rows
  // are simply back in the queue next time. Nothing permanent happens by leaving.
  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live.values()) clearTimeout(timer);
      live.clear();
    };
  }, []);

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

  const nextSeq = () => {
    seqRef.current += 1;
    return seqRef.current;
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
    if (exclusive) inFlight.current = true;
    const requestIds = filed.map((item) => item.transactionId);
    const seq = nextSeq();
    send({
      type: 'acceptStarted',
      items: filed,
      entry: { seq, kind: 'accept', label, transactionIds: requestIds, confirmed: false },
    });
    const request = (async () => {
      try {
        const result = await accept({ budgetId, items }).unwrap();
        const ids = result.items.map((item) => item.transaction_id);
        resultIds.current.set(seq, ids);
        send({ type: 'acceptSucceeded', seq, transactionIds: ids, requestIds, label });
        return true;
      } catch (err) {
        send({ type: 'acceptFailed', seq, requestIds, error: apiErrorMessage(err, t('error.accept')) });
        queueRefetch();
        return false;
      } finally {
        if (exclusive) inFlight.current = false;
      }
    })();
    requests.current.set(seq, request);
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

  /** This skip's own timer ended: it goes out now and leaves the undo stack. */
  const sendSkip = (seq: number) => {
    timers.current.delete(seq);
    const entry = stateRef.current.stack.find((e) => e.seq === seq);
    if (!budgetId || !entry || entry.kind !== 'skip') return;
    const { item } = entry;
    send({ type: 'skipSending', seq });
    skip({ budgetId, transactionId: item.transactionId })
      .unwrap()
      .then(
        () => send({ type: 'skipDone', requestId: item.transactionId }),
        (err: unknown) => {
          send({ type: 'skipFailed', requestId: item.transactionId, error: apiErrorMessage(err, t('error.skip')) });
          queueRefetch();
        },
      );
  };

  const skipRow = (row: CategorizeQueueRow): boolean => {
    if (!budgetId) return false;
    const item = filedItem(row, '', '');
    const seq = nextSeq();
    const sendAt = Date.now() + UNDO_TOAST_MS;
    send({ type: 'skipStarted', entry: { seq, kind: 'skip', label: skippedLabel(item), item, sendAt } });
    timers.current.set(seq, setTimeout(() => sendSkip(seq), UNDO_TOAST_MS));
    return true;
  };

  const cancelSkip = (transactionId: string): boolean => {
    const entry = stateRef.current.stack.find((e) => e.kind === 'skip' && e.item.transactionId === transactionId);
    if (!entry) return false;
    const timer = timers.current.get(entry.seq);
    if (timer) clearTimeout(timer);
    timers.current.delete(entry.seq);
    send({ type: 'skipCancelled', transactionId });
    return true;
  };

  /**
   * Accept one bundle. The server resolves the rows from the bundle key and
   * knows nothing of a skip that is still pending, so while any skip is pending
   * the rows are fetched and sent explicitly, minus the rows being left out
   * (the count check stands in for the server's `expected_count` guard).
   */
  const acceptBundleRows = async (bundle: CategorizeBundle): Promise<CategorizeDecisionItem[]> => {
    if (!budgetId) return [];
    if (pendingSkips(stateRef.current).length === 0) {
      const result = await accept({ budgetId, bundleKey: bundle.bundle_key, expectedCount: bundle.count }).unwrap();
      return result.items;
    }
    const rows = await bundleItems(bundle);
    if (rows.length !== bundle.count) {
      throw { status: 409, code: 'categorize_bundle_changed', params: { expected: bundle.count, actual: rows.length } };
    }
    const items = withoutPendingSkips(rows, stateRef.current);
    const accepted: CategorizeDecisionItem[] = [];
    for (let i = 0; i < items.length; i += ACCEPT_BATCH) {
      const result = await accept({ budgetId, items: items.slice(i, i + ACCEPT_BATCH) }).unwrap();
      accepted.push(...result.items);
    }
    return accepted;
  };

  const acceptBundle = (bundle: CategorizeBundle, knownRows: readonly CategorizeQueueRow[]): Promise<boolean> => {
    if (!budgetId || inFlight.current) return Promise.resolve(false);
    inFlight.current = true;
    markGone(bundle.bundle_key, true);
    const leaving = new Set(pendingSkips(stateRef.current).map((entry) => entry.item.transactionId));
    const filed = knownRows
      .filter((row) => !leaving.has(row.transaction_id))
      .map((row) => filedItem(row, bundle.suggestion.category_id, bundle.suggestion.category_name));
    const requestIds = filed.map((item) => item.transactionId);
    const seq = nextSeq();
    send({
      type: 'acceptStarted',
      items: filed,
      entry: { seq, kind: 'accept', label: bundleToastLabel(bundle), transactionIds: [], confirmed: false },
    });
    const request = (async () => {
      try {
        const accepted = await acceptBundleRows(bundle);
        const ids = accepted.map((item) => item.transaction_id);
        resultIds.current.set(seq, ids);
        send({
          type: 'acceptSucceeded',
          seq,
          transactionIds: ids,
          requestIds,
          label: bundleToastLabel({ ...bundle, count: ids.length }),
        });
        return true;
      } catch (err) {
        const changed = isBundleChanged(err);
        send({
          type: 'acceptFailed',
          seq,
          requestIds,
          error: changed ? bundleChangedMessage(err) : apiErrorMessage(err, t('error.accept')),
        });
        markGone(bundle.bundle_key, false);
        if (changed) setBundleChangeTick((tick) => tick + 1);
        queueRefetch();
        return false;
      } finally {
        inFlight.current = false;
      }
    })();
    requests.current.set(seq, request);
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
    inFlight.current = true;
    setGoneBundleKeys(new Set(bundles.map((bundle) => bundle.bundle_key)));
    const seq = nextSeq();
    send({
      type: 'acceptStarted',
      items: [],
      entry: { seq, kind: 'accept', label: '', transactionIds: [], confirmed: false },
    });
    const accepted: CategorizeDecisionItem[] = [];
    const finish = (error?: string) => {
      const ids = accepted.map((item) => item.transaction_id);
      if (ids.length > 0) {
        resultIds.current.set(seq, ids);
        send({
          type: 'acceptSucceeded',
          seq,
          transactionIds: ids,
          requestIds: [],
          label: filedCountLabel(ids.length),
          error,
        });
      } else {
        send({ type: 'acceptFailed', seq, requestIds: [], error: error ?? t('error.accept') });
      }
    };
    const request = (async () => {
      try {
        const all: CategorizeDecisionItem[] = [];
        for (const bundle of bundles) all.push(...(await bundleItems(bundle)));
        // Rows the person is leaving out (a skip pending) are not part of "accept all".
        const items = withoutPendingSkips(all, stateRef.current);
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
    requests.current.set(seq, request);
    return request;
  };

  const undoLast = async (): Promise<string[]> => {
    if (!budgetId) return [];
    // Claim the top entry NOW, in press order: a press made while this waits
    // takes the next one down, never the one the person saw undone.
    const entry = topEntry(stateRef.current);
    if (!entry) return [];

    if (entry.kind === 'skip') {
      return cancelSkip(entry.item.transactionId) ? [entry.item.transactionId] : [];
    }

    send({ type: 'undoClaimed', seq: entry.seq });
    // Pressed while its request is in flight: wait for the answer, never drop the press.
    const answered = await (requests.current.get(entry.seq) ?? Promise.resolve(true));
    const ids = resultIds.current.get(entry.seq) ?? (answered ? entry.transactionIds : []);
    requests.current.delete(entry.seq);
    resultIds.current.delete(entry.seq);
    if (!answered || ids.length === 0) return [];

    send({ type: 'undoStarted' });
    const summary = await undoInChunks(ids, (chunk) => undo({ budgetId, transactionIds: chunk }).unwrap());
    const outcome = undoOutcome(summary);
    // What was not reached stays undoable, on top; what the server left alone cannot be undone.
    const remaining =
      summary.remaining.length > 0
        ? { seq: entry.seq, kind: 'accept' as const, label: entry.label, transactionIds: summary.remaining, confirmed: true }
        : null;
    const back = [...summary.restored, ...summary.alreadyRestored];
    send({ type: 'undoFinished', restoredIds: back, remaining, message: outcome.text, tone: outcome.tone });
    if (summary.failed) queueRefetch();
    return back;
  };

  return {
    state,
    idle: acceptIdle(state),
    goneBundleKeys,
    bundleChangeTick,
    fileRow,
    pickCategory,
    skipRow,
    cancelSkip,
    acceptBundle,
    acceptAll,
    undoLast,
    dismissError: () => send({ type: 'clearError' }),
  };
}
