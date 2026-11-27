import { describe, expect, test } from 'bun:test';

import {
  acceptIdle,
  acceptReducer,
  answeredIdSet,
  canUndo,
  filedCountLabel,
  filedLabel,
  hiddenIdSet,
  insertBySeq,
  initialAcceptState,
  pendingSkips,
  queueLeaving,
  sendingCount,
  skippedLabel,
  toastActionable,
  topEntry,
  topIsUndoable,
  unlocked,
  waitingSkips,
  visibleRows,
  withoutPendingSkips,
  type AcceptAction,
  type AcceptState,
  type FiledItem,
  type UndoEntry,
} from './accept.logic';

const filed = (transactionId: string, categoryName = 'Transport'): FiledItem => ({
  transactionId,
  categoryId: `cat-${categoryName}`,
  categoryName,
  subject: `Uber · –R$ 18,90`,
});

const run = (actions: AcceptAction[], from: AcceptState = initialAcceptState) => actions.reduce(acceptReducer, from);

const acceptEntry = (seq: number, ids: string[], label = `A${seq}`) =>
  ({ seq, kind: 'accept', label, transactionIds: ids, confirmed: false }) as Extract<UndoEntry, { kind: 'accept' }>;
const start = (seq: number, id: string): AcceptAction => ({
  type: 'acceptStarted',
  items: [filed(id)],
  entry: acceptEntry(seq, [id]),
});
const ok = (seq: number, id: string): AcceptAction => ({
  type: 'acceptSucceeded',
  seq,
  transactionIds: [id],
  requestIds: [id],
  label: `A${seq}`,
});
const meta = { payeeId: 'p1', topCategoryId: 'c1', amount: -1000 };
const skipEntry = (seq: number, id: string) =>
  ({ seq, kind: 'skip', label: `S${seq}`, item: filed(id), meta }) as Extract<UndoEntry, { kind: 'skip' }>;
const skipStart = (seq: number, id: string): AcceptAction => ({ type: 'skipStarted', entry: skipEntry(seq, id) });

describe('accepting', () => {
  test('start hides the filed rows, keeps them pending and puts the action on the stack', () => {
    const state = run([start(1, 't1')]);
    expect(state.hiddenIds).toEqual(['t1']);
    expect(state.pending.map((i) => i.transactionId)).toEqual(['t1']);
    expect(state.stack.map((e) => e.seq)).toEqual([1]);
    expect(acceptIdle(state)).toBe(false);
    expect(canUndo(state)).toBe(true);
  });

  test('a success confirms the entry and shows its toast with Undo', () => {
    const state = run([start(1, 't1'), ok(1, 't1')]);
    expect(topEntry(state)).toMatchObject({ seq: 1, confirmed: true, transactionIds: ['t1'] });
    expect(state.toast).toEqual({ label: 'A1', seq: 1 });
    expect(toastActionable(state)).toBe(true);
    expect(acceptIdle(state)).toBe(true);
  });

  test('a late answer for an earlier press leaves the later press its toast', () => {
    const state = run([start(1, 'a'), start(2, 'b'), ok(2, 'b'), ok(1, 'a')]);
    expect(state.toast).toEqual({ label: 'A2', seq: 2 });
    expect(state.stack.map((e) => e.seq)).toEqual([1, 2]);
    expect(state.hiddenIds.sort()).toEqual(['a', 'b']);
  });

  test('A filed, B fails: A stays filed with its toast and Undo, B comes back with the message', () => {
    const state = run([
      start(1, 'a'),
      start(2, 'b'),
      ok(1, 'a'),
      { type: 'acceptFailed', seq: 2, requestIds: ['b'], error: 'B failed' },
    ]);
    expect(state.hiddenIds).toEqual(['a']);
    expect(state.error).toBe('B failed');
    expect(state.stack.map((e) => e.seq)).toEqual([1]);
    expect(state.toast).toEqual({ label: 'A1', seq: 1 });
    expect(toastActionable(state)).toBe(true);
    expect(acceptIdle(state)).toBe(true);
  });

  test('a batch that went through only in part keeps the accepted rows and says so, counting one request', () => {
    const state = run([
      { type: 'acceptStarted', items: [], entry: acceptEntry(1, []) },
      { type: 'acceptSucceeded', seq: 1, transactionIds: ['t1'], requestIds: [], label: '1 filed', error: 'Half' },
    ]);
    expect(state.hiddenIds).toEqual(['t1']);
    expect(state.error).toBe('Half');
    expect(topEntry(state)).toMatchObject({ transactionIds: ['t1'], confirmed: true });
    expect(acceptIdle(state)).toBe(true);
  });
});

describe('the undo stack', () => {
  test('S, then 1: nothing sends the skip, both are on the stack in press order', () => {
    const state = run([skipStart(1, 's1'), start(2, 'a'), ok(2, 'a')]);
    expect(state.stack.map((e) => e.kind)).toEqual(['skip', 'accept']);
    expect(state.hiddenIds.sort()).toEqual(['a', 's1']);
    expect(pendingSkips(state).map((s) => s.item.transactionId)).toEqual(['s1']);
    expect(state.pending.map((i) => i.transactionId)).toEqual([]);
  });

  test('S, 1, Z, Z: the accept comes off first, then the skip is cancelled', () => {
    let state = run([skipStart(1, 's1'), start(2, 'a'), ok(2, 'a')]);
    expect(topEntry(state)?.seq).toBe(2);
    state = run([{ type: 'undoClaimed', seq: 2 }, { type: 'undoStarted' }], state);
    state = run(
      [{ type: 'undoFinished', restoredIds: ['a'], remaining: null, message: 'Undid 1 transaction.', tone: 'ok' }],
      state,
    );
    expect(state.hiddenIds).toEqual(['s1']);
    expect(topEntry(state)?.seq).toBe(1);
    state = run([{ type: 'skipCancelled', transactionId: 's1' }], state);
    expect(state.hiddenIds).toEqual([]);
    expect(canUndo(state)).toBe(false);
  });

  test('S, S: each waits in the strip on its own and either can be cancelled', () => {
    let state = run([skipStart(1, 's1'), skipStart(2, 's2')]);
    expect(pendingSkips(state).length).toBe(2);
    state = run([{ type: 'skipCancelled', transactionId: 's1' }], state);
    expect(pendingSkips(state).map((s) => s.item.transactionId)).toEqual(['s2']);
    expect(state.hiddenIds).toEqual(['s2']);
  });

  test('a skip that is sent (Done) leaves the stack and its toast goes: Z then reaches the action before it', () => {
    let state = run([start(1, 'a'), ok(1, 'a'), skipStart(2, 's1')]);
    expect(toastActionable(state)).toBe(true);
    state = run([{ type: 'skipSending', seq: 2 }], state);
    expect(state.stack.map((e) => e.seq)).toEqual([1]);
    expect(state.toast).toBeNull();
    expect(acceptIdle(state)).toBe(false);
    state = run([{ type: 'skipDone', requestId: 's1' }], state);
    expect(state.hiddenIds.sort()).toEqual(['a', 's1']);
    expect(acceptIdle(state)).toBe(true);
    expect(topEntry(state)?.seq).toBe(1);
  });

  test('a failed skip send brings its row back with the error', () => {
    const state = run([
      skipStart(1, 's1'),
      { type: 'skipSending', seq: 1 },
      { type: 'skipFailed', requestId: 's1', error: 'No' },
    ]);
    expect(state.hiddenIds).toEqual([]);
    expect(state.error).toBe('No');
    expect(acceptIdle(state)).toBe(true);
  });

  test('the toast shows Undo only while its action is the one Undo reverses', () => {
    const state = run([start(1, 'a'), ok(1, 'a'), skipStart(2, 's1')]);
    expect(state.toast?.seq).toBe(2);
    expect(toastActionable(state)).toBe(true);
    const later = run([start(3, 'b')], state);
    expect(later.toast).toBeNull();
    const msg = run([{ type: 'undoFinished', restoredIds: [], remaining: null, message: 'x', tone: 'ok' }], state);
    expect(toastActionable(msg)).toBe(false);
  });

  test('cancelling the top skip brings back the toast of the action below it', () => {
    const state = run([start(1, 'a'), ok(1, 'a'), skipStart(2, 's1'), { type: 'skipCancelled', transactionId: 's1' }]);
    expect(state.toast).toEqual({ label: 'A1', seq: 1 });
  });
});

describe('undo outcome', () => {
  const accepted = () => run([start(1, 't1'), ok(1, 't1'), { type: 'undoClaimed', seq: 1 }, { type: 'undoStarted' }]);

  test('a full undo un-hides the rows and says how many', () => {
    const state = acceptReducer(accepted(), {
      type: 'undoFinished',
      restoredIds: ['t1'],
      remaining: null,
      message: 'Undid 1 transaction.',
      tone: 'ok',
    });
    expect(state.hiddenIds).toEqual([]);
    expect(state.toast).toEqual({ label: 'Undid 1 transaction.', seq: 0 });
    expect(state.error).toBeNull();
    expect(canUndo(state)).toBe(false);
    expect(acceptIdle(state)).toBe(true);
  });

  test('a partial undo is an error line, not a success, and puts what was not reached back on top', () => {
    const rest = { ...acceptEntry(1, ['t2']), confirmed: true };
    const state = acceptReducer(accepted(), {
      type: 'undoFinished',
      restoredIds: ['t1'],
      remaining: rest,
      message: 'Undid 1 of 2 transactions.',
      tone: 'problem',
    });
    expect(state.toast).toBeNull();
    expect(state.error).toContain('Undid 1 of 2');
    expect(topEntry(state)).toBe(rest);
  });
});

describe('prune and visibility', () => {
  test('drops hidden ids the queue no longer lists, keeps listed, in-flight and pending-skip ones', () => {
    const state = run([
      start(1, 't1'),
      ok(1, 't1'),
      start(2, 't2'),
      ok(2, 't2'),
      start(3, 't3'),
      skipStart(4, 's1'),
      { type: 'prune', presentIds: ['t2'] },
    ]);
    expect(state.hiddenIds.sort()).toEqual(['s1', 't2', 't3']);
  });

  test('a transfer answer stays hidden across a queue re-read that never lists it', () => {
    // Jev's transfer answers are not in the category queue, so the queue is no
    // witness for them: they live in their own set, which no queue re-read
    // touches, and the queue's counts never see them.
    const state = run([
      { type: 'acceptStarted', items: [filed('x1')], entry: { ...acceptEntry(1, ['x1']), fromTransfer: true } },
      { type: 'acceptSucceeded', seq: 1, transactionIds: ['x1'], requestIds: ['x1'], label: 'A1' },
      { type: 'prune', presentIds: [] },
    ]);
    expect(state.transferIds).toEqual(['x1']);
    expect(state.hiddenIds).toEqual([]);
  });

  test('returns the same state when nothing is dropped', () => {
    const state = run([start(1, 't1'), ok(1, 't1')]);
    expect(acceptReducer(state, { type: 'prune', presentIds: ['t1'] })).toBe(state);
  });

  test('visibleRows drops the hidden ids', () => {
    const rows = [{ transaction_id: 't1' }, { transaction_id: 't2' }, { transaction_id: 't3' }];
    expect(visibleRows(rows, hiddenIdSet({ hiddenIds: ['t2'] })).map((r) => r.transaction_id)).toEqual(['t1', 't3']);
    expect(visibleRows(rows, hiddenIdSet({ hiddenIds: [] }))).toEqual(rows);
  });

  test('reset forgets everything; clearing an error keeps the rest', () => {
    const state = run([start(1, 't1'), ok(1, 't1')]);
    expect(acceptReducer(state, { type: 'clearError' }).hiddenIds).toEqual(['t1']);
    expect(acceptReducer(state, { type: 'reset' })).toEqual(initialAcceptState);
  });
});

describe('sentences', () => {
  test('single row names the subject and the category', () => {
    expect(filedLabel({ subject: 'Uber · –R$ 18,90', categoryName: 'Transport' })).toBe('Uber · –R$ 18,90 → Transport');
  });

  test('a batch counts its transactions', () => {
    expect(filedCountLabel(1)).toBe('1 transaction filed');
    expect(filedCountLabel(96)).toBe('96 transactions filed');
  });

  test('a skip says nothing is sent until Done', () => {
    expect(skippedLabel({ subject: 'Uber · –R$ 18,90' })).toBe(
      'Uber · –R$ 18,90 moved to “Leaving uncategorized”. Nothing is sent until you press Done.',
    );
  });
});

describe('skips taken back without being asked', () => {
  test('a failed send comes back with the error and is reported as reverted', () => {
    const state = run([
      skipStart(1, 's1'),
      { type: 'skipSending', seq: 1 },
      { type: 'skipFailed', requestId: 's1', error: 'No' },
    ]);
    expect(state.reverted).toEqual(['s1']);
    expect(state.hiddenIds).toEqual([]);
  });

  test('a row that left the queue some other way drops its pending skip: not sent, reported as reverted', () => {
    const state = run([start(1, 'a'), ok(1, 'a'), skipStart(2, 's1'), { type: 'skipDropped', transactionId: 's1' }]);
    expect(pendingSkips(state)).toEqual([]);
    expect(state.reverted).toEqual(['s1']);
    expect(acceptIdle(state)).toBe(true);
    expect(state.pending).toEqual([]);
    expect(state.toast).toEqual({ label: 'A1', seq: 1 });
  });

  test('dropping a skip that is not pending changes nothing', () => {
    const state = run([start(1, 'a')]);
    expect(acceptReducer(state, { type: 'skipDropped', transactionId: 'zzz' })).toBe(state);
  });

  test('cancelling a skip clears an older message toast instead of keeping it', () => {
    let state = run([start(1, 'a'), ok(1, 'a'), { type: 'undoClaimed', seq: 1 }, { type: 'undoStarted' }]);
    state = run([{ type: 'undoFinished', restoredIds: ['a'], remaining: null, message: 'Undid 1 transaction.', tone: 'ok' }], state);
    expect(state.toast?.label).toBe('Undid 1 transaction.');
    state = run([skipStart(2, 's1'), { type: 'skipCancelled', transactionId: 's1' }], state);
    expect(state.toast).toBeNull();
  });
});

describe('a failed undo keeps its place in the press order', () => {
  test('the unreached part goes back below newer actions, not on top of them', () => {
    let state = run([start(1, 'a'), ok(1, 'a'), { type: 'undoClaimed', seq: 1 }, { type: 'undoStarted' }, start(2, 'b'), ok(2, 'b')]);
    const rest = { ...acceptEntry(1, ['a']), confirmed: true };
    state = run([{ type: 'undoFinished', restoredIds: [], remaining: rest, message: 'x', tone: 'problem' }], state);
    expect(state.stack.map((e) => e.seq)).toEqual([1, 2]);
    expect(topEntry(state)?.seq).toBe(2);
  });

  test('insertBySeq puts an entry in order wherever it fits', () => {
    const e = (seq: number) => acceptEntry(seq, []);
    expect(insertBySeq([e(1), e(3)], e(2)).map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(insertBySeq([], e(1)).map((x) => x.seq)).toEqual([1]);
    expect(insertBySeq([e(1)], e(2)).map((x) => x.seq)).toEqual([1, 2]);
  });
});

describe('bulk accepts leave pending skips out', () => {
  test('rows with a pending skip are removed from the items', () => {
    const state = run([skipStart(1, 's1')]);
    const items = [{ transaction_id: 's1' }, { transaction_id: 'x' }];
    expect(withoutPendingSkips(items, state)).toEqual([{ transaction_id: 'x' }]);
    expect(withoutPendingSkips(items, initialAcceptState)).toEqual(items);
  });
});

describe('no timer: nothing sends a skip but Done', () => {
  test('a skip stays in the strip across any other action', () => {
    const state = run([skipStart(1, 's1'), start(2, 'a'), ok(2, 'a'), start(3, 'b'), ok(3, 'b')]);
    expect(pendingSkips(state).map((s) => s.item.transactionId)).toEqual(['s1']);
    expect(state.pending.map((i) => i.transactionId)).toEqual([]);
    expect(acceptIdle(state)).toBe(true);
  });

  test('Done sends every skip in the strip and each leaves the stack as it goes', () => {
    let state = run([skipStart(1, 's1'), skipStart(2, 's2')]);
    state = run([{ type: 'skipSending', seq: 1 }, { type: 'skipSending', seq: 2 }], state);
    expect(pendingSkips(state)).toEqual([]);
    expect(state.pending.map((i) => i.transactionId)).toEqual(['s1', 's2']);
    expect(state.busy).toBe(2);
    state = run([{ type: 'skipDone', requestId: 's1' }, { type: 'skipDone', requestId: 's2' }], state);
    expect(acceptIdle(state)).toBe(true);
    expect(state.hiddenIds.sort()).toEqual(['s1', 's2']);
  });

  test('"Stay" puts the rows back in the strip, below anything newer', () => {
    const state = run([start(5, 'a'), ok(5, 'a'), { type: 'skipsRestored', entries: [skipEntry(1, 's1'), skipEntry(2, 's2')] }]);
    expect(state.stack.map((e) => e.seq)).toEqual([1, 2, 5]);
    expect(state.hiddenIds.sort()).toEqual(['a', 's1', 's2']);
  });
});

describe('an accept with no rows', () => {
  test('leaves no undo entry, no toast and no busy count', () => {
    const state = run([
      skipStart(1, 's1'),
      { type: 'acceptStarted', items: [], entry: acceptEntry(2, []) },
      { type: 'acceptEmpty', seq: 2, requestIds: [] },
    ]);
    expect(state.stack.map((e) => e.seq)).toEqual([1]);
    expect(acceptIdle(state)).toBe(true);
    expect(state.toast).toEqual({ label: 'S1', seq: 1 });
  });
});

describe('Done locks the rows it will send', () => {
  const locked = () => run([start(1, 'a'), ok(1, 'a'), skipStart(2, 's1'), skipStart(3, 's2'), { type: 'skipsLocked', seqs: [2, 3] }]);

  test('a locked row cannot be undone from the strip', () => {
    const state = acceptReducer(locked(), { type: 'skipCancelled', transactionId: 's1' });
    expect(pendingSkips(state).length).toBe(2);
    expect(state.hiddenIds).toContain('s1');
  });

  test('Z does not pass over the locked rows to undo an older accept: the top is not undoable', () => {
    const state = locked();
    expect(topEntry(state)?.seq).toBe(3);
    expect(topIsUndoable(state)).toBe(false);
    expect(sendingCount(state)).toBe(2);
    expect(toastActionable(state)).toBe(false);
  });

  test('rows Done has taken are not offered to the leave prompt; a restored row is never locked', () => {
    const state = run([skipStart(1, 's1'), skipStart(2, 's2'), { type: 'skipsLocked', seqs: [1] }]);
    expect(waitingSkips(state).map((e) => e.item.transactionId)).toEqual(['s2']);
    const locked1 = pendingSkips(state)[0]!;
    expect(locked1.sending).toBe(true);
    expect('sending' in unlocked(locked1)).toBe(false);
  });

  test('each row leaves the stack as its own request starts, and the busy count stays balanced', () => {
    let state = locked();
    state = run([{ type: 'skipSending', seq: 2 }], state);
    expect(state.busy).toBe(1);
    state = run([{ type: 'skipDone', requestId: 's1' }, { type: 'skipSending', seq: 3 }, { type: 'skipDone', requestId: 's2' }], state);
    expect(state.busy).toBe(0);
    expect(acceptIdle(state)).toBe(true);
    expect(pendingSkips(state)).toEqual([]);
  });

  test('a send that may pass (network) puts the row back in the strip, unlocked, in its place, with the error', () => {
    let state = locked();
    const entry = state.stack.find((e) => e.seq === 2) as Extract<UndoEntry, { kind: 'skip' }>;
    state = run([{ type: 'skipSending', seq: 2 }, { type: 'skipRetained', entry, error: 'Offline' }], state);
    expect(state.busy).toBe(0);
    expect(state.error).toBe('Offline');
    expect(state.stack.map((e) => e.seq)).toEqual([1, 2, 3]);
    const back = state.stack.find((e) => e.seq === 2) as Extract<UndoEntry, { kind: 'skip' }>;
    expect(back.sending).toBeUndefined();
    expect(state.hiddenIds).toContain('s1');
  });
});

describe('queue rows and Jev transfer answers hide in their own sets', () => {
  const transferSkip = (seq: number, id: string) =>
    ({ ...skipEntry(seq, id), fromTransfer: true }) as Extract<UndoEntry, { kind: 'skip' }>;

  test('refusing an answer moves no queue count: only the transfer list hides it', () => {
    // W2: the queue's counts are the server's and the queue never listed it, so
    // the optimistic hide must not touch the set the counter subtracts.
    let state = run([{ type: 'refuseStarted', ids: ['x1'] }]);
    expect(state.transferIds).toEqual(['x1']);
    expect(state.hiddenIds).toEqual([]);
    state = run([{ type: 'refuseFinished', ids: ['x1'] }], state);
    expect(state.transferIds).toEqual(['x1']);
    expect(state.hiddenIds).toEqual([]);
  });

  test('a failed refusal gives the answer back to both sets', () => {
    const state = run([{ type: 'refuseStarted', ids: ['x1'] }, { type: 'refuseFailed', ids: ['x1'] }]);
    expect(state.transferIds).toEqual([]);
    expect(state.hiddenIds).toEqual([]);
  });

  test('a skipped queue row hides from the queue; a skipped answer hides from the answers', () => {
    const state = run([
      skipStart(1, 'q1'),
      { type: 'skipStarted', entry: transferSkip(2, 'x1') },
    ]);
    expect(state.hiddenIds).toEqual(['q1']);
    expect(state.transferIds).toEqual(['x1']);
    // Both lists filter on the union, so neither row shows twice.
    expect([...answeredIdSet(state)].sort()).toEqual(['q1', 'x1']);
  });

  test('only the skips the queue counts move the badge (W3)', () => {
    const state = run([skipStart(1, 'q1'), { type: 'skipStarted', entry: transferSkip(2, 'x1') }]);
    expect(pendingSkips(state)).toHaveLength(2);
    expect(queueLeaving(pendingSkips(state)).map((e) => e.item.transactionId)).toEqual(['q1']);
  });
});
