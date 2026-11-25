/**
 * The Categorize accept flow: optimistic filing, the undo toast and the
 * server's answer. Every request is built from the queue data the page shows
 * (explicit pairs for rows and for "accept all", one server-resolved bundle
 * for a card). A failure restores exactly the optimistically hidden rows and
 * refetches the queue; a bundle whose count moved (409) also drops the
 * optimistic card so the fresh count shows.
 *
 * Undo and Z pop a STACK of the visit's actions in key-press order. An accept
 * is undone through the API (waiting for its answer if it is still in flight).
 * A skip is permanent and budget-wide, so it is NEVER sent on a timer: it waits
 * in the "Leaving uncategorized" strip, where Undo (or Z) cancels it and its
 * row returns, until the person presses Done. Leaving the page or switching
 * budget with rows in the strip hands them to the leave prompt (Send and leave /
 * Keep them and leave / Stay); closing the tab sends nothing.
 */

import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';

import {
  budgetApi,
  useAcceptCategorizeMutation,
  useSkipCategorizeMutation,
  useUndoCategorizeMutation,
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
import { leaveStore } from './leave.store';
import { useUnloadGuard } from './useUnloadGuard';
import type { ShownBundle } from './queue.logic';
import { t } from './i18n';
import { bundleChangedMessage, bundleToastLabel, isBundleChanged, rowSubject, type PickedCategory } from './page.logic';
import { undoInChunks, undoOutcome } from './undo.logic';

/** How long the message toast stays; a skip in the strip does not depend on it. */
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
  /** Move the row to the "Leaving uncategorized" strip; nothing is sent until Done. */
  skipRow: (row: CategorizeQueueRow) => boolean;
  /** Take one row out of the strip (its row returns); false when it is not there any more. */
  cancelSkip: (transactionId: string) => boolean;
  /** Done: send every row in the strip, permanently, for the whole budget. */
  sendSkips: () => Promise<void>;
  acceptBundle: (bundle: ShownBundle, knownRows: readonly CategorizeQueueRow[]) => Promise<boolean>;
  acceptAll: (bundles: readonly ShownBundle[]) => Promise<boolean>;
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
  const sendingSkips = useRef(false);
  /** False once the page is gone: a late answer must not touch the (unmounted) queue hook. */
  const mounted = useRef(true);
  const refetch = () => {
    if (mounted.current) queueRefetch();
  };

  const nextSeq = () => {
    seqRef.current += 1;
    return seqRef.current;
  };

  const rowIdsRef = useRef(queueRowIds);
  rowIdsRef.current = queueRowIds;
  useEffect(() => {
    setGoneBundleKeys(new Set());
    // A pending skip whose row has left the queue (categorized elsewhere, taken
    // by a bulk accept) is dropped, never sent: there is nothing left to skip.
    const present = new Set(rowIdsRef.current);
    for (const entry of pendingSkips(stateRef.current)) {
      if (present.has(entry.item.transactionId)) continue;
      send({ type: 'skipDropped', transactionId: entry.item.transactionId });
    }
    send({ type: 'prune', presentIds: rowIdsRef.current });
  }, [queueUpdatedAt]);

  useEffect(() => {
    if (!state.toast) return;
    const id = setTimeout(() => send({ type: 'dismissToast' }), UNDO_TOAST_MS);
    return () => clearTimeout(id);
  }, [state.toast]);

  // A page opened again after "Stay" takes its strip back.
  useEffect(() => {
    if (!budgetId) return;
    const restored = leaveStore.takeRestore(budgetId);
    if (restored.length === 0) return;
    send({
      type: 'skipsRestored',
      entries: restored.map((entry) => ({ ...entry, seq: nextSeq() })),
    });
  }, [budgetId]);

  // The page publishes what is in its strip, every time it changes. The shell
  // watches the route and the active budget: when either leaves this page with rows
  // still in the strip, it asks what to do with them (a page torn down by the
  // navigator cannot be relied on to speak for itself). Nothing is sent from here.
  const stack = state.stack;
  useUnloadGuard(pendingSkips({ stack }).length > 0);
  useEffect(() => {
    if (budgetId) leaveStore.publish(budgetId, pendingSkips({ stack }));
  }, [budgetId, stack]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Gone (a budget switch): the prompt can no longer reach this page, only its last strip.
      if (budgetId) leaveStore.pageClosed(budgetId);
    };
  }, [budgetId]);

  // The prompt dealt with rows of this strip while the page was behind another route.
  const commands = useSyncExternalStore(leaveStore.subscribe, () => leaveStore.getState().commands);
  useEffect(() => {
    if (!budgetId || commands.length === 0) return;
    for (const command of leaveStore.takeCommands(budgetId)) {
      for (const id of command.ids) {
        const entry = stateRef.current.stack.find((e) => e.kind === 'skip' && e.item.transactionId === id);
        if (!entry) continue;
        if (command.kind === 'sent') {
          // Already sent by the prompt: leave the strip, rows stay hidden.
          send({ type: 'skipSending', seq: entry.seq });
          send({ type: 'skipDone', requestId: id });
        } else {
          send({ type: 'skipDropped', transactionId: id });
        }
      }
    }
  }, [budgetId, commands]);

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
        refetch();
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

  /** Done: every row in the strip is sent now, one request each, and leaves the stack as it goes. */
  const sendSkips = async (): Promise<void> => {
    if (!budgetId || sendingSkips.current) return;
    sendingSkips.current = true;
    try {
      let failed = false;
      for (const entry of pendingSkips(stateRef.current)) {
        const { item } = entry;
        send({ type: 'skipSending', seq: entry.seq });
        try {
          await skip({ budgetId, transactionId: item.transactionId }).unwrap();
          send({ type: 'skipDone', requestId: item.transactionId });
        } catch (err) {
          failed = true;
          send({ type: 'skipFailed', requestId: item.transactionId, error: apiErrorMessage(err, t('error.skip')) });
        }
      }
      if (failed) refetch();
    } finally {
      sendingSkips.current = false;
    }
  };

  const skipRow = (row: CategorizeQueueRow): boolean => {
    if (!budgetId) return false;
    const item = filedItem(row, '', '');
    const seq = nextSeq();
    const meta = {
      payeeId: row.payee_id,
      topCategoryId: row.suggestions[0]?.category_id ?? null,
      amount: row.amount,
    };
    send({ type: 'skipStarted', entry: { seq, kind: 'skip', label: skippedLabel(item), item, meta } });
    return true;
  };

  const cancelSkip = (transactionId: string): boolean => {
    const entry = stateRef.current.stack.find((e) => e.kind === 'skip' && e.item.transactionId === transactionId);
    if (!entry) return false;
    send({ type: 'skipCancelled', transactionId });
    return true;
  };

  /**
   * Accept one bundle. The server resolves the rows from the bundle key and
   * knows nothing of a skip that is still pending, so while any skip is pending
   * the rows are fetched and sent explicitly, minus the rows being left out
   * (the count check stands in for the server's `expected_count` guard).
   */
  const acceptBundleRows = async (bundle: ShownBundle): Promise<CategorizeDecisionItem[]> => {
    if (!budgetId) return [];
    if (pendingSkips(stateRef.current).length === 0) {
      const result = await accept({ budgetId, bundleKey: bundle.bundle_key, expectedCount: bundle.serverCount }).unwrap();
      return result.items;
    }
    const rows = await bundleItems(bundle);
    if (rows.length !== bundle.serverCount) {
      throw {
        status: 409,
        code: 'categorize_bundle_changed',
        params: { expected: bundle.serverCount, actual: rows.length },
      };
    }
    const items = withoutPendingSkips(rows, stateRef.current);
    const accepted: CategorizeDecisionItem[] = [];
    for (let i = 0; i < items.length; i += ACCEPT_BATCH) {
      const result = await accept({ budgetId, items: items.slice(i, i + ACCEPT_BATCH) }).unwrap();
      accepted.push(...result.items);
    }
    return accepted;
  };

  const acceptBundle = (bundle: ShownBundle, knownRows: readonly CategorizeQueueRow[]): Promise<boolean> => {
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
        if (ids.length === 0) {
          // Every row of the bundle was already in the strip or gone: nothing to undo, nothing to say.
          send({ type: 'acceptEmpty', seq, requestIds });
          markGone(bundle.bundle_key, false);
          refetch();
          return false;
        }
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
        refetch();
        return false;
      } finally {
        inFlight.current = false;
      }
    })();
    requests.current.set(seq, request);
    return request;
  };

  /** Every row of one bundle, paged at the contract's 200-row cap. */
  const bundleItems = async (bundle: ShownBundle): Promise<CategorizeDecisionItem[]> => {
    if (!budgetId) return [];
    const items: CategorizeDecisionItem[] = [];
    for (let offset = 0; offset < bundle.serverCount; offset += QUEUE_PAGE) {
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

  const acceptAll = (bundles: readonly ShownBundle[]): Promise<boolean> => {
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
          refetch();
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
        refetch();
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
    if (summary.failed) refetch();
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
    sendSkips,
    acceptBundle,
    acceptAll,
    undoLast,
    dismissError: () => send({ type: 'clearError' }),
  };
}
