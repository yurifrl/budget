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
  /** The in-flight accept; null when idle. */
  pending: FiledItem[] | null;
  toast: UndoToast | null;
  /** A sentence for the failed accept/undo; cleared when the next action starts. */
  error: string | null;
  /** What the last undo reversed, for the toast/summary line. */
  lastUndo: { restored: number; skipped: number } | null;
}

export const initialAcceptState: AcceptState = {
  hiddenIds: [],
  pending: null,
  toast: null,
  error: null,
  lastUndo: null,
};

export type AcceptAction =
  | { type: 'start'; items: FiledItem[] }
  | { type: 'failed'; error: string }
  | { type: 'succeeded'; transactionIds: string[]; label: string }
  | { type: 'undoStarted' }
  | { type: 'undoSucceeded'; transactionIds: string[]; restored: number; skipped: number }
  | { type: 'undoFailed'; error: string }
  | { type: 'dismissToast' }
  | { type: 'reset' };

function without(ids: readonly string[], remove: readonly string[]): string[] {
  const drop = new Set(remove);
  return ids.filter((id) => !drop.has(id));
}

export function acceptReducer(state: AcceptState, action: AcceptAction): AcceptState {
  switch (action.type) {
    case 'start':
      return {
        ...state,
        hiddenIds: [...new Set([...state.hiddenIds, ...action.items.map((item) => item.transactionId)])],
        pending: action.items,
        toast: null,
        error: null,
        lastUndo: null,
      };
    case 'failed': {
      const restore = state.pending?.map((item) => item.transactionId) ?? [];
      return { ...state, hiddenIds: without(state.hiddenIds, restore), pending: null, error: action.error };
    }
    case 'succeeded':
      return {
        ...state,
        hiddenIds: [...new Set([...state.hiddenIds, ...action.transactionIds])],
        pending: null,
        toast: { label: action.label, transactionIds: action.transactionIds },
        error: null,
      };
    case 'undoStarted':
      return { ...state, pending: [], error: null };
    case 'undoSucceeded':
      return {
        ...state,
        hiddenIds: without(state.hiddenIds, action.transactionIds),
        pending: null,
        toast: null,
        error: null,
        lastUndo: { restored: action.restored, skipped: action.skipped },
      };
    case 'undoFailed':
      return { ...state, pending: null, error: action.error };
    case 'dismissToast':
      return { ...state, toast: null };
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
export function acceptIdle(state: Pick<AcceptState, 'pending'>): boolean {
  return state.pending === null;
}

/** The undo toast is actionable while no request is in flight and something is undoable. */
export function canUndo(state: Pick<AcceptState, 'pending' | 'toast'>): boolean {
  return state.pending === null && state.toast !== null;
}

/** "Uber · –R$ 18,90 → Transport" for a single filed row. */
export function filedLabel(item: Pick<FiledItem, 'subject' | 'categoryName'>): string {
  return t('toast.filed', { subject: item.subject, category: item.categoryName });
}

/** "96 transactions filed" for a batch (accept-all). */
export function filedCountLabel(count: number): string {
  return t('toast.filedCount', { count });
}
