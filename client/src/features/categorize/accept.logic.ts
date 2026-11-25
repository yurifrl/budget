/**
 * Optimistic state of accepting, skipping and undoing categories. Filing is
 * optimistic: the rows leave the queue at once, the server answer keeps them
 * out and turns the action into an undo toast. A failure restores exactly the
 * rows the failed request hid. A skip is permanent and budget-wide, so it is
 * only SENT when its toast runs out: until then it is a hidden row that Undo
 * (or Z) puts back. The hook owns the requests and timers; this reducer owns
 * only what the person sees.
 */

import { t } from './i18n';
import type { UndoTarget } from './undo.logic';

/** One row filed optimistically: enough to hide it and name it in the toast. */
export interface FiledItem {
  transactionId: string;
  categoryId: string;
  categoryName: string;
  /** "Uber · –R$ 18,90" (payee and amount already formatted). */
  subject: string;
}

export interface ToastState {
  /** The whole sentence, already translated. */
  label: string;
  /** Shows the Undo action. */
  actionable: boolean;
}

export interface AcceptState {
  /** Rows hidden from the queue while a request is in flight, confirmed or a skip is pending. */
  hiddenIds: string[];
  /** Rows of the requests still in flight (single-row filings may overlap). */
  pending: FiledItem[];
  /** Requests in flight: accepts, skip sends and undos. Idle at 0. */
  busy: number;
  /** The message toast on screen; it times out. */
  toast: ToastState | null;
  /**
   * What Undo and Z reverse: the last thing the person did. It outlives the
   * toast, so a timed-out accept can still be undone (the server has no limit).
   */
  undoable: UndoTarget | null;
  /** A sentence for the failed request or the partly failed undo; kept until dismissed. */
  error: string | null;
}

export const initialAcceptState: AcceptState = {
  hiddenIds: [],
  pending: [],
  busy: 0,
  toast: null,
  undoable: null,
  error: null,
};

export type AcceptAction =
  | { type: 'start'; items: FiledItem[] }
  /** `requestIds` are the ids the failed request hid (what `start` was given). */
  | { type: 'failed'; error: string; requestIds: string[] }
  | {
      type: 'succeeded';
      transactionIds: string[];
      requestIds: string[];
      label: string;
      /** False when a later press already owns the toast. */
      showToast: boolean;
      /** Set when only part of a batch went through: the accepted part stays, the failure is said. */
      error?: string;
    }
  | { type: 'setUndoable'; target: UndoTarget | null }
  /** A skip begins: the row is hidden and the toast offers Undo; nothing is sent yet. */
  | { type: 'skipStarted'; item: FiledItem; label: string }
  /** The skip was undone inside its window: the row comes back. */
  | { type: 'skipCancelled'; transactionId: string }
  /** The window ran out (or another action began): the skip request goes out. */
  | { type: 'skipSending'; item: FiledItem }
  | { type: 'skipDone'; requestId: string }
  | { type: 'undoStarted' }
  | {
      type: 'undoFinished';
      /** Rows the server put back in the queue. */
      restoredIds: string[];
      /** What stays undoable (chunks not reached); null when nothing does. */
      undoable: UndoTarget | null;
      message: string;
      tone: 'ok' | 'problem';
    }
  | { type: 'dismissToast' }
  | { type: 'clearError' }
  /** The queue was re-read: ids it no longer lists need no optimistic hiding. */
  | { type: 'prune'; presentIds: readonly string[] }
  | { type: 'reset' };

function without(ids: readonly string[], remove: readonly string[]): string[] {
  const drop = new Set(remove);
  return ids.filter((id) => !drop.has(id));
}

function union(ids: readonly string[], add: readonly string[]): string[] {
  return [...new Set([...ids, ...add])];
}

function settle(pending: FiledItem[], requestIds: readonly string[]): FiledItem[] {
  const done = new Set(requestIds);
  return pending.filter((item) => !done.has(item.transactionId));
}

const less = (busy: number) => Math.max(0, busy - 1);

export function acceptReducer(state: AcceptState, action: AcceptAction): AcceptState {
  switch (action.type) {
    case 'start':
      return {
        ...state,
        hiddenIds: union(state.hiddenIds, action.items.map((item) => item.transactionId)),
        pending: [...state.pending, ...action.items],
        busy: state.busy + 1,
        toast: null,
        error: null,
      };
    case 'failed':
      return {
        ...state,
        hiddenIds: without(state.hiddenIds, action.requestIds),
        pending: settle(state.pending, action.requestIds),
        busy: less(state.busy),
        error: action.error,
      };
    case 'succeeded':
      return {
        ...state,
        hiddenIds: union(state.hiddenIds, action.transactionIds),
        pending: settle(state.pending, action.requestIds),
        busy: less(state.busy),
        toast: action.showToast ? { label: action.label, actionable: true } : state.toast,
        error: action.error ?? null,
      };
    case 'setUndoable':
      return { ...state, undoable: action.target };
    case 'skipStarted':
      return {
        ...state,
        hiddenIds: union(state.hiddenIds, [action.item.transactionId]),
        toast: { label: action.label, actionable: true },
        error: null,
      };
    case 'skipCancelled':
      return {
        ...state,
        hiddenIds: without(state.hiddenIds, [action.transactionId]),
        toast: null,
      };
    case 'skipSending':
      return { ...state, pending: [...state.pending, action.item], busy: state.busy + 1 };
    case 'skipDone':
      return { ...state, pending: settle(state.pending, [action.requestId]), busy: less(state.busy) };
    case 'undoStarted':
      return { ...state, busy: state.busy + 1, error: null };
    case 'undoFinished':
      return {
        ...state,
        hiddenIds: without(state.hiddenIds, action.restoredIds),
        busy: less(state.busy),
        undoable: action.undoable,
        toast: action.tone === 'ok' ? { label: action.message, actionable: false } : null,
        error: action.tone === 'problem' ? action.message : null,
      };
    case 'dismissToast':
      return { ...state, toast: null };
    case 'clearError':
      return { ...state, error: null };
    case 'prune': {
      if (state.hiddenIds.length === 0) return state;
      const present = new Set(action.presentIds);
      const inFlight = new Set(state.pending.map((item) => item.transactionId));
      const hiddenIds = state.hiddenIds.filter((id) => present.has(id) || inFlight.has(id));
      return hiddenIds.length === state.hiddenIds.length ? state : { ...state, hiddenIds };
    }
    case 'reset':
      return initialAcceptState;
  }
}

/** Rows hidden from the visible queue (optimistically filed or pending a skip). */
export function hiddenIdSet(state: Pick<AcceptState, 'hiddenIds'>): ReadonlySet<string> {
  return new Set(state.hiddenIds);
}

export function visibleRows<T extends { transaction_id: string }>(
  rows: readonly T[],
  hidden: ReadonlySet<string>,
): T[] {
  return hidden.size === 0 ? [...rows] : rows.filter((row) => !hidden.has(row.transaction_id));
}

/** Nothing may be bulk-accepted while a request is in flight. */
export function acceptIdle(state: Pick<AcceptState, 'busy'>): boolean {
  return state.busy === 0;
}

/**
 * Undo is offered whenever the last thing done can be reversed, even while its
 * request is still in flight: pressing Z then waits for the answer instead of
 * being ignored.
 */
export function canUndo(state: Pick<AcceptState, 'undoable'>): boolean {
  return state.undoable !== null;
}

/** "Uber · –R$ 18,90 → Transport" for a single filed row. */
export function filedLabel(item: Pick<FiledItem, 'subject' | 'categoryName'>): string {
  return t('toast.filed', { subject: item.subject, category: item.categoryName });
}

/** The toast while a skip is still pending: says it is permanent and for everyone. */
export function skippedLabel(item: Pick<FiledItem, 'subject'>): string {
  return t('toast.skipped', { subject: item.subject });
}

/** "96 transactions filed" for a batch (accept-all). */
export function filedCountLabel(count: number): string {
  return t('toast.filedCount', { count });
}
