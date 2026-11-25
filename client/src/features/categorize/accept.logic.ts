/**
 * Optimistic state of accepting (and undoing) categories. Filing is optimistic:
 * the accepted rows leave the queue at once, the server answer keeps them out
 * and turns the action into an undo toast. A failure restores exactly the rows
 * the failed accept hid. The screen/hook owns the requests and the toast timer;
 * this reducer owns only what the person sees.
 */

import { t } from './i18n';

/** One row filed optimistically: enough to hide it and name it in the toast. */
export interface FiledItem {
  transactionId: string;
  categoryId: string;
  categoryName: string;
  /** "Uber · –R$ 18,90" (payee and amount already formatted). */
  subject: string;
}

export interface UndoToast {
  /** The whole sentence already translated, e.g. "Uber · –R$ 18,90 → Transport". */
  label: string;
  /** Server-confirmed transaction ids; undo sends exactly these back. */
  transactionIds: string[];
}

export interface AcceptState {
  /** Rows hidden from the queue while an accept is in flight or confirmed. */
  hiddenIds: string[];
  /** Rows of the accepts still in flight (single-row filings may overlap). */
  pending: FiledItem[];
  /** Requests in flight: accepts and undos. Idle at 0. */
  busy: number;
  /** The message toast on screen; it times out. */
  toast: UndoToast | null;
  /**
   * The last confirmed accept, kept after its toast timed out: "Undo last" and
   * the Z key still reverse it (the server has no undo time limit) until the
   * next accept replaces it or an undo consumes it.
   */
  undoable: UndoToast | null;
  /** A sentence for the failed accept/undo; cleared when the next action starts. */
  error: string | null;
  /** What the last undo reversed, for the toast/summary line. */
  lastUndo: { restored: number; skipped: number } | null;
}

export const initialAcceptState: AcceptState = {
  hiddenIds: [],
  pending: [],
  busy: 0,
  toast: null,
  undoable: null,
  error: null,
  lastUndo: null,
};

export type AcceptAction =
  | { type: 'start'; items: FiledItem[] }
  /** `requestIds` are the ids the failed request hid (what `start` was given). */
  | { type: 'failed'; error: string; requestIds: string[] }
  | { type: 'succeeded'; transactionIds: string[]; requestIds: string[]; label: string }
  /** A skip hides its row like an accept but keeps the current undo toast; a failure is `failed`. */
  | { type: 'skipStarted'; item: FiledItem }
  | { type: 'skipSucceeded'; requestId: string; label: string }
  | { type: 'undoStarted' }
  | { type: 'undoSucceeded'; transactionIds: string[]; restored: number; skipped: number }
  | { type: 'undoFailed'; error: string }
  | { type: 'dismissToast' }
  | { type: 'clearError' }
  /** The queue was re-read: ids it no longer lists need no optimistic hiding. */
  | { type: 'prune'; presentIds: readonly string[] }
  | { type: 'reset' };

function without(ids: readonly string[], remove: readonly string[]): string[] {
  const drop = new Set(remove);
  return ids.filter((id) => !drop.has(id));
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
        hiddenIds: [...new Set([...state.hiddenIds, ...action.items.map((item) => item.transactionId)])],
        pending: [...state.pending, ...action.items],
        busy: state.busy + 1,
        toast: null,
        error: null,
        lastUndo: null,
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
        hiddenIds: [...new Set([...state.hiddenIds, ...action.transactionIds])],
        pending: settle(state.pending, action.requestIds),
        busy: less(state.busy),
        toast: { label: action.label, transactionIds: action.transactionIds },
        undoable: action.transactionIds.length > 0 ? { label: action.label, transactionIds: action.transactionIds } : state.undoable,
        error: null,
      };
    case 'skipStarted':
      return {
        ...state,
        hiddenIds: [...new Set([...state.hiddenIds, action.item.transactionId])],
        pending: [...state.pending, action.item],
        busy: state.busy + 1,
        error: null,
      };
    case 'skipSucceeded':
      return {
        ...state,
        pending: settle(state.pending, [action.requestId]),
        busy: less(state.busy),
        // A skip has nothing to undo: the toast only says it happened.
        toast: { label: action.label, transactionIds: [] },
      };
    case 'undoStarted':
      return { ...state, busy: state.busy + 1, error: null };
    case 'undoSucceeded':
      return {
        ...state,
        hiddenIds: without(state.hiddenIds, action.transactionIds),
        busy: less(state.busy),
        toast: null,
        undoable: null,
        error: null,
        lastUndo: { restored: action.restored, skipped: action.skipped },
      };
    case 'undoFailed':
      return { ...state, busy: less(state.busy), error: action.error };
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

/** Rows hidden from the visible queue (optimistically filed). */
export function hiddenIdSet(state: Pick<AcceptState, 'hiddenIds'>): ReadonlySet<string> {
  return new Set(state.hiddenIds);
}

export function visibleRows<T extends { transaction_id: string }>(
  rows: readonly T[],
  hidden: ReadonlySet<string>,
): T[] {
  return hidden.size === 0 ? [...rows] : rows.filter((row) => !hidden.has(row.transaction_id));
}

/** Nothing may be accepted or skipped while a request is in flight. */
export function acceptIdle(state: Pick<AcceptState, 'busy'>): boolean {
  return state.busy === 0;
}

/** Undo is available while no request is in flight and an accept is undoable. */
export function canUndo(state: Pick<AcceptState, 'busy' | 'undoable'>): boolean {
  return state.busy === 0 && state.undoable !== null && state.undoable.transactionIds.length > 0;
}

/** "Uber · –R$ 18,90 → Transport" for a single filed row. */
export function filedLabel(item: Pick<FiledItem, 'subject' | 'categoryName'>): string {
  return t('toast.filed', { subject: item.subject, category: item.categoryName });
}

/** "Skipped Uber · –R$ 18,90" for a skip. */
export function skippedLabel(item: Pick<FiledItem, 'subject'>): string {
  return t('toast.skipped', { subject: item.subject });
}

/** "96 transactions filed" for a batch (accept-all). */
export function filedCountLabel(count: number): string {
  return t('toast.filedCount', { count });
}
