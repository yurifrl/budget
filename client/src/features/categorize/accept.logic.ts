/**
 * Optimistic state of accepting, skipping and undoing categories. Filing is
 * optimistic: the rows leave the queue at once, the server answer keeps them
 * out and a failure restores exactly the rows the failed request hid.
 *
 * Undo is a STACK of the visit's actions in key-press order. Undo and Z pop
 * the top: an accept is undone through the API, a pending skip is cancelled and
 * its row comes back. A skip is permanent and budget-wide, so it is NEVER sent
 * on a timer: it waits in the "Leaving uncategorized" strip until the person
 * presses Done (or answers "Send and leave" when leaving the page). A sent skip
 * leaves the stack (it cannot be undone), so Z goes to the action before it.
 * The hook owns the requests; this reducer owns what the person sees.
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

/** What a row in the strip is, for the counts that must not include it. */
export interface LeavingMeta {
  payeeId: string | null;
  /** The category of the row's top suggestion: with the payee, which bundle it belongs to. */
  topCategoryId: string | null;
  /** Integer milliunits. */
  amount: number;
}

export type SkipEntry = Extract<UndoEntry, { kind: 'skip' }>;

export type UndoEntry =
  | {
      seq: number;
      kind: 'accept';
      label: string;
      /** Known up front for a single row, filled from the server's answer for batches. */
      transactionIds: string[];
      confirmed: boolean;
    }
  | {
      seq: number;
      kind: 'skip';
      label: string;
      item: FiledItem;
      meta: LeavingMeta;
    };

export interface ToastState {
  /** The whole sentence, already translated. */
  label: string;
  /** The stack entry the toast speaks of; 0 for a plain message. Undo shows while that entry is on top. */
  seq: number;
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
  /** What Undo and Z reverse, oldest first: the last element is the next to undo. */
  stack: UndoEntry[];
  /** A sentence for the failed request or the partly failed undo; kept until dismissed. */
  error: string | null;
  /**
   * Skips taken back WITHOUT the person asking (the send failed, or the row left
   * the queue some other way), oldest first. The One by one view drops their
   * lines and counts from it.
   */
  reverted: string[];
}

export const initialAcceptState: AcceptState = {
  hiddenIds: [],
  pending: [],
  busy: 0,
  toast: null,
  stack: [],
  error: null,
  reverted: [],
};

export type AcceptAction =
  | { type: 'acceptStarted'; items: FiledItem[]; entry: Extract<UndoEntry, { kind: 'accept' }> }
  | {
      type: 'acceptSucceeded';
      seq: number;
      transactionIds: string[];
      requestIds: string[];
      label: string;
      /** Set when only part of a batch went through: the accepted part stays, the failure is said. */
      error?: string;
    }
  | { type: 'acceptFailed'; seq: number; requestIds: string[]; error: string }
  /** A skip begins: the row is hidden and the toast offers Undo; nothing is sent yet. */
  | { type: 'skipStarted'; entry: Extract<UndoEntry, { kind: 'skip' }> }
  /** Undone (or cancelled) inside its window: the row comes back. */
  | { type: 'skipCancelled'; transactionId: string }
  /** Done was pressed: the request goes out and the skip leaves the stack. */
  | { type: 'skipSending'; seq: number }
  /** "Stay" after leaving with rows in the strip: they are put back, in the order they were taken. */
  | { type: 'skipsRestored'; entries: SkipEntry[] }
  /** An accept that turned out to hold no rows (all were leaving or gone): no undo entry, no toast. */
  | { type: 'acceptEmpty'; seq: number; requestIds: string[] }
  | { type: 'skipDone'; requestId: string }
  | { type: 'skipFailed'; requestId: string; error: string }
  /** The row left the queue some other way (categorized elsewhere, taken by a bulk accept): the pending skip is dropped, not sent. */
  | { type: 'skipDropped'; transactionId: string }
  /** Undo took the entry off the stack (an accept whose rows are about to be restored). */
  | { type: 'undoClaimed'; seq: number }
  | { type: 'undoStarted' }
  | {
      type: 'undoFinished';
      /** Rows that are back in the queue. */
      restoredIds: string[];
      /** What was not reached stays undoable, on top. */
      remaining: Extract<UndoEntry, { kind: 'accept' }> | null;
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

/** Put an entry back where its press order says, not on top of newer actions. */
export function insertBySeq(stack: readonly UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const next = [...stack];
  const at = next.findIndex((e) => e.seq > entry.seq);
  next.splice(at === -1 ? next.length : at, 0, entry);
  return next;
}

/** Items of an accept without the rows that have a skip pending: the person already chose to leave those out. */
export function withoutPendingSkips<T extends { transaction_id: string }>(
  items: readonly T[],
  state: Pick<AcceptState, 'stack'>,
): T[] {
  const leaving = new Set(pendingSkips(state).map((entry) => entry.item.transactionId));
  return leaving.size === 0 ? [...items] : items.filter((item) => !leaving.has(item.transaction_id));
}

export function topEntry(state: Pick<AcceptState, 'stack'>): UndoEntry | null {
  return state.stack[state.stack.length - 1] ?? null;
}

function toastFor(entry: UndoEntry | null): ToastState | null {
  return entry ? { label: entry.label, seq: entry.seq } : null;
}

/**
 * After an entry is gone, a toast that speaks of another live action stays; a
 * toast for the removed entry, or an old plain message ("Undid 1 transaction."),
 * is replaced by the toast of the action that is now on top, if any.
 */
function toastAfterRemoval(state: AcceptState, stack: UndoEntry[], removedSeq: number): ToastState | null {
  if (state.toast && state.toast.seq !== removedSeq && state.toast.seq !== 0) return state.toast;
  return toastFor(stack[stack.length - 1] ?? null);
}

export function acceptReducer(state: AcceptState, action: AcceptAction): AcceptState {
  switch (action.type) {
    case 'acceptStarted':
      return {
        ...state,
        hiddenIds: union(state.hiddenIds, action.items.map((item) => item.transactionId)),
        pending: [...state.pending, ...action.items],
        busy: state.busy + 1,
        stack: [...state.stack, action.entry],
        toast: null,
        error: null,
      };
    case 'acceptSucceeded': {
      const stack = state.stack.map((entry) =>
        entry.kind === 'accept' && entry.seq === action.seq
          ? { ...entry, label: action.label, transactionIds: action.transactionIds, confirmed: true }
          : entry,
      );
      const latest = stack[stack.length - 1]?.seq === action.seq;
      return {
        ...state,
        hiddenIds: union(state.hiddenIds, action.transactionIds),
        pending: settle(state.pending, action.requestIds),
        busy: less(state.busy),
        stack,
        // A late answer for an earlier press leaves the later press's toast alone.
        toast: latest ? { label: action.label, seq: action.seq } : state.toast,
        error: action.error ?? null,
      };
    }
    case 'acceptFailed': {
      const stack = state.stack.filter((entry) => entry.seq !== action.seq);
      return {
        ...state,
        hiddenIds: without(state.hiddenIds, action.requestIds),
        pending: settle(state.pending, action.requestIds),
        busy: less(state.busy),
        stack,
        toast: toastAfterRemoval(state, stack, action.seq),
        error: action.error,
      };
    }
    case 'skipStarted':
      return {
        ...state,
        hiddenIds: union(state.hiddenIds, [action.entry.item.transactionId]),
        stack: [...state.stack, action.entry],
        toast: toastFor(action.entry),
        error: null,
      };
    case 'skipsRestored':
      return {
        ...state,
        hiddenIds: union(state.hiddenIds, action.entries.map((e) => e.item.transactionId)),
        stack: [...action.entries, ...state.stack],
      };
    case 'acceptEmpty': {
      const stack = state.stack.filter((entry) => entry.seq !== action.seq);
      return {
        ...state,
        hiddenIds: without(state.hiddenIds, action.requestIds),
        pending: settle(state.pending, action.requestIds),
        busy: less(state.busy),
        stack,
        toast: toastAfterRemoval(state, stack, action.seq),
      };
    }
    case 'skipCancelled': {
      const gone = state.stack.find((e) => e.kind === 'skip' && e.item.transactionId === action.transactionId);
      const stack = state.stack.filter((e) => e !== gone);
      return {
        ...state,
        hiddenIds: without(state.hiddenIds, [action.transactionId]),
        stack,
        toast: gone ? toastAfterRemoval(state, stack, gone.seq) : state.toast,
      };
    }
    case 'skipSending': {
      const entry = state.stack.find((e) => e.seq === action.seq);
      if (!entry || entry.kind !== 'skip') return state;
      const stack = state.stack.filter((e) => e !== entry);
      return {
        ...state,
        stack,
        pending: [...state.pending, entry.item],
        busy: state.busy + 1,
        // Sent: it cannot be undone any more, so its toast goes (it never falls back to an older one).
        toast: state.toast?.seq === action.seq ? null : state.toast,
      };
    }
    case 'skipDone':
      return { ...state, pending: settle(state.pending, [action.requestId]), busy: less(state.busy) };
    case 'skipFailed':
      return {
        ...state,
        hiddenIds: without(state.hiddenIds, [action.requestId]),
        pending: settle(state.pending, [action.requestId]),
        busy: less(state.busy),
        error: action.error,
        reverted: [...state.reverted, action.requestId],
      };
    case 'skipDropped': {
      const gone = state.stack.find((e) => e.kind === 'skip' && e.item.transactionId === action.transactionId);
      if (!gone) return state;
      const stack = state.stack.filter((e) => e !== gone);
      return {
        ...state,
        hiddenIds: without(state.hiddenIds, [action.transactionId]),
        stack,
        toast: toastAfterRemoval(state, stack, gone.seq),
        reverted: [...state.reverted, action.transactionId],
      };
    }
    case 'undoClaimed': {
      const stack = state.stack.filter((entry) => entry.seq !== action.seq);
      return { ...state, stack, toast: state.toast?.seq === action.seq ? null : state.toast };
    }
    case 'undoStarted':
      return { ...state, busy: state.busy + 1, error: null };
    case 'undoFinished':
      return {
        ...state,
        hiddenIds: without(state.hiddenIds, action.restoredIds),
        busy: less(state.busy),
        stack: action.remaining ? insertBySeq(state.stack, action.remaining) : state.stack,
        toast: action.tone === 'ok' ? { label: action.message, seq: 0 } : null,
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
      const pendingSkips = new Set(
        state.stack.flatMap((entry) => (entry.kind === 'skip' ? [entry.item.transactionId] : [])),
      );
      const hiddenIds = state.hiddenIds.filter((id) => present.has(id) || inFlight.has(id) || pendingSkips.has(id));
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
 * Undo is offered whenever the stack has an entry, even while its request is
 * still in flight: pressing Z then waits for the answer instead of being ignored.
 */
export function canUndo(state: Pick<AcceptState, 'stack'>): boolean {
  return state.stack.length > 0;
}

/** The toast shows its Undo only while the action it speaks of is the one Undo would reverse. */
export function toastActionable(state: Pick<AcceptState, 'toast' | 'stack'>): boolean {
  const top = state.stack[state.stack.length - 1];
  return state.toast !== null && top !== undefined && top.seq === state.toast.seq;
}

/** The skips waiting in the strip for Done, oldest first. */
export function pendingSkips(state: Pick<AcceptState, 'stack'>): SkipEntry[] {
  return state.stack.filter((entry): entry is SkipEntry => entry.kind === 'skip');
}

/** "Uber · –R$ 18,90 → Transport" for a single filed row. */
export function filedLabel(item: Pick<FiledItem, 'subject' | 'categoryName'>): string {
  return t('toast.filed', { subject: item.subject, category: item.categoryName });
}

/** The toast for a row moved to the strip: nothing is sent until Done. */
export function skippedLabel(item: Pick<FiledItem, 'subject'>): string {
  return t('toast.skipped', { subject: item.subject });
}

/** "96 transactions filed" for a batch (accept-all). */
export function filedCountLabel(count: number): string {
  return t('toast.filedCount', { count });
}
