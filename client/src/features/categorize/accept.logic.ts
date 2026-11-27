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
      /**
       * The rows are Jev transfer answers, not category-queue rows: they are
       * never in the category queue, so its re-read can tell nothing about them
       * and must not un-hide them.
       */
      fromTransfer?: boolean;
    }
  | {
      seq: number;
      kind: 'skip';
      label: string;
      item: FiledItem;
      meta: LeavingMeta;
      /** Done (or "Send and leave") reached for it: Undo is off, the request is queued or out. */
      sending?: boolean;
      /**
       * The row is a Jev transfer answer, not a category-queue row: it is never in
       * the category queue, so the queue re-read can tell nothing about it.
       */
      fromTransfer?: boolean;
    };

export interface ToastState {
  /** The whole sentence, already translated. */
  label: string;
  /** The stack entry the toast speaks of; 0 for a plain message. Undo shows while that entry is on top. */
  seq: number;
}

export interface AcceptState {
  /** Queue rows hidden while a request is in flight, confirmed or a skip is pending. */
  hiddenIds: string[];
  /**
   * Jev's transfer answers hidden from Jev's own lists (refused or skipped, in
   * flight or landed). They are never in the category queue, so no queue count
   * and no queue re-read may see them: hiding one there subtracted a row the
   * queue's counts still listed.
   */
  transferIds: string[];
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
  transferIds: [],
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
  /** A Jev transfer answer is hidden while its refusal is on its way: no stack entry, no toast. */
  | { type: 'refuseStarted'; ids: string[] }
  /** The refusal landed: the row stays hidden from Jev's lists until they are re-read. */
  | { type: 'refuseFinished'; ids: string[] }
  /** The refusal failed: the row comes back. */
  | { type: 'refuseFailed'; ids: string[] }
  /** A skip begins: the row is hidden and the toast offers Undo; nothing is sent yet. */
  | { type: 'skipStarted'; entry: Extract<UndoEntry, { kind: 'skip' }> }
  /** Undone (or cancelled) inside its window: the row comes back. */
  | { type: 'skipCancelled'; transactionId: string }
  /** Done was pressed: these rows are locked (no Undo, Z skips them) until their request has answered. */
  | { type: 'skipsLocked'; seqs: number[] }
  /** The request for a locked row goes out now: it leaves the stack. */
  | { type: 'skipSending'; seq: number }
  /** The send failed for a reason that may pass (network, server): the row stays in the strip for a retry. */
  | { type: 'skipRetained'; entry: SkipEntry; error: string }
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
  /** A plain message ("sending…"): not an action, never undoable. */
  | { type: 'notice'; label: string }
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

/**
 * Hide rows in the set their list belongs to: a queue row leaves the queue's
 * lists and counts, a Jev transfer answer leaves Jev's lists only.
 */
function hide(
  state: AcceptState,
  ids: readonly string[],
  fromTransfer: boolean | undefined,
): AcceptState {
  if (ids.length === 0) return state;
  return fromTransfer
    ? { ...state, transferIds: union(state.transferIds, ids) }
    : { ...state, hiddenIds: union(state.hiddenIds, ids) };
}

/** Put rows back in whichever set hid them: one row is only ever in one. */
function release(state: AcceptState, ids: readonly string[]): AcceptState {
  return { ...state, hiddenIds: without(state.hiddenIds, ids), transferIds: without(state.transferIds, ids) };
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

/** The action Undo and Z reverse: the most recent one. A row locked by Done is still the top: Z then says so, it never passes over it. */
export function topEntry(state: Pick<AcceptState, 'stack'>): UndoEntry | null {
  return state.stack[state.stack.length - 1] ?? null;
}

/** Rows locked by Done: they cannot be undone any more, and Z says so instead of doing nothing. */
export function sendingCount(state: Pick<AcceptState, 'stack'>): number {
  return state.stack.filter((e) => e.kind === 'skip' && e.sending).length;
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
      return hide(
        {
          ...state,
          pending: [...state.pending, ...action.items],
          busy: state.busy + 1,
          stack: [...state.stack, action.entry],
          toast: null,
          error: null,
        },
        action.items.map((item) => item.transactionId),
        action.entry.fromTransfer,
      );
    case 'acceptSucceeded': {
      const sent = state.stack.find((entry) => entry.kind === 'accept' && entry.seq === action.seq);
      const stack = state.stack.map((entry) =>
        entry.kind === 'accept' && entry.seq === action.seq
          ? { ...entry, label: action.label, transactionIds: action.transactionIds, confirmed: true }
          : entry,
      );
      const latest = stack[stack.length - 1]?.seq === action.seq;
      return hide(
        {
          ...state,
          pending: settle(state.pending, action.requestIds),
          busy: less(state.busy),
          stack,
          // A late answer for an earlier press leaves the later press's toast alone.
          toast: latest ? { label: action.label, seq: action.seq } : state.toast,
          error: action.error ?? null,
        },
        action.transactionIds,
        sent?.fromTransfer,
      );
    }
    case 'acceptFailed': {
      const stack = state.stack.filter((entry) => entry.seq !== action.seq);
      return release(
        {
          ...state,
          pending: settle(state.pending, action.requestIds),
          busy: less(state.busy),
          stack,
          toast: toastAfterRemoval(state, stack, action.seq),
          error: action.error,
        },
        action.requestIds,
      );
    }
    case 'refuseStarted':
      return hide({ ...state, busy: state.busy + 1 }, action.ids, true);
    case 'refuseFinished':
      return { ...state, busy: less(state.busy) };
    case 'refuseFailed':
      return { ...release(state, action.ids), busy: less(state.busy) };
    case 'skipStarted':
      return hide(
        { ...state, stack: [...state.stack, action.entry], toast: toastFor(action.entry), error: null },
        [action.entry.item.transactionId],
        action.entry.fromTransfer,
      );
    case 'skipsRestored': {
      const restored = { ...state, stack: [...action.entries, ...state.stack] };
      return action.entries.reduce(
        (next, entry) => hide(next, [entry.item.transactionId], entry.fromTransfer),
        restored,
      );
    }
    case 'acceptEmpty': {
      const stack = state.stack.filter((entry) => entry.seq !== action.seq);
      return release(
        {
          ...state,
          pending: settle(state.pending, action.requestIds),
          busy: less(state.busy),
          stack,
          toast: toastAfterRemoval(state, stack, action.seq),
        },
        action.requestIds,
      );
    }
    case 'skipsLocked': {
      const locked = new Set(action.seqs);
      return {
        ...state,
        stack: state.stack.map((e) => (e.kind === 'skip' && locked.has(e.seq) ? { ...e, sending: true } : e)),
      };
    }
    case 'skipRetained': {
      const { sending: _sending, ...entry } = action.entry;
      return {
        ...state,
        pending: settle(state.pending, [entry.item.transactionId]),
        busy: less(state.busy),
        stack: insertBySeq(state.stack, entry),
        error: action.error,
      };
    }
    case 'skipCancelled': {
      const locked = state.stack.find(
        (e) => e.kind === 'skip' && e.item.transactionId === action.transactionId && e.sending,
      );
      if (locked) return state;
      const gone = state.stack.find((e) => e.kind === 'skip' && e.item.transactionId === action.transactionId);
      const stack = state.stack.filter((e) => e !== gone);
      return release(
        {
          ...state,
          stack,
          toast: gone ? toastAfterRemoval(state, stack, gone.seq) : state.toast,
        },
        [action.transactionId],
      );
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
      return release(
        {
          ...state,
          pending: settle(state.pending, [action.requestId]),
          busy: less(state.busy),
          error: action.error,
          reverted: [...state.reverted, action.requestId],
        },
        [action.requestId],
      );
    case 'skipDropped': {
      const gone = state.stack.find((e) => e.kind === 'skip' && e.item.transactionId === action.transactionId);
      if (!gone) return state;
      const stack = state.stack.filter((e) => e !== gone);
      return release(
        {
          ...state,
          stack,
          toast: toastAfterRemoval(state, stack, gone.seq),
          reverted: [...state.reverted, action.transactionId],
        },
        [action.transactionId],
      );
    }
    case 'undoClaimed': {
      const stack = state.stack.filter((entry) => entry.seq !== action.seq);
      return { ...state, stack, toast: state.toast?.seq === action.seq ? null : state.toast };
    }
    case 'undoStarted':
      return { ...state, busy: state.busy + 1, error: null };
    case 'undoFinished':
      return release(
        {
          ...state,
          busy: less(state.busy),
          stack: action.remaining ? insertBySeq(state.stack, action.remaining) : state.stack,
          toast: action.tone === 'ok' ? { label: action.message, seq: 0 } : null,
          error: action.tone === 'problem' ? action.message : null,
        },
        action.restoredIds,
      );
    case 'notice':
      return { ...state, toast: { label: action.label, seq: 0 } };
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
      const hiddenIds = state.hiddenIds.filter(
        (id) => present.has(id) || inFlight.has(id) || pendingSkips.has(id),
      );
      return hiddenIds.length === state.hiddenIds.length ? state : { ...state, hiddenIds };
    }
    case 'reset':
      return initialAcceptState;
  }
}

/** Queue rows hidden from the queue's own lists and counts (filed, or a skip pending). */
export function hiddenIdSet(state: Pick<AcceptState, 'hiddenIds'>): ReadonlySet<string> {
  return new Set(state.hiddenIds);
}

/**
 * Every row answered optimistically, queue rows and Jev's transfer answers
 * alike: what a list of rows must leave out whatever list it is.
 */
export function answeredIdSet(state: Pick<AcceptState, 'hiddenIds' | 'transferIds'>): ReadonlySet<string> {
  return state.transferIds.length === 0
    ? new Set(state.hiddenIds)
    : new Set([...state.hiddenIds, ...state.transferIds]);
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

/** True when Z has something to undo right now (the top is not a row Done is sending). */
export function topIsUndoable(state: Pick<AcceptState, 'stack'>): boolean {
  const top = topEntry(state);
  return top !== null && !(top.kind === 'skip' && top.sending);
}

/** The rows a page may offer the leave prompt: those still waiting (Done has committed the others). */
export function waitingSkips(state: Pick<AcceptState, 'stack'>): SkipEntry[] {
  return pendingSkips(state).filter((entry) => !entry.sending);
}

/** A restored row is never "sending": whatever Done took is gone, the rest is plainly waiting. */
export function unlocked(entry: SkipEntry): SkipEntry {
  const { sending: _sending, ...rest } = entry;
  return rest;
}

/** The toast shows its Undo only while the action it speaks of is the one Undo would reverse. */
export function toastActionable(state: Pick<AcceptState, 'toast' | 'stack'>): boolean {
  const top = topEntry(state);
  return state.toast !== null && top !== null && top.seq === state.toast.seq && topIsUndoable(state);
}

/** The skips waiting in the strip for Done, oldest first. */
export function pendingSkips(state: Pick<AcceptState, 'stack'>): SkipEntry[] {
  return state.stack.filter((entry): entry is SkipEntry => entry.kind === 'skip');
}

/**
 * The skips that move the queue's count: a Jev transfer answer is never in the
 * category queue, so skipping it changes no "left to categorize" number. The
 * header, the badge and the strip's own count all read this one rule.
 */
export function queueLeaving(entries: readonly SkipEntry[]): SkipEntry[] {
  return entries.filter((entry) => !entry.fromTransfer);
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
