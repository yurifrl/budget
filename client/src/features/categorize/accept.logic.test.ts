import { describe, expect, test } from 'bun:test';

import {
  acceptIdle,
  acceptReducer,
  canUndo,
  filedCountLabel,
  filedLabel,
  hiddenIdSet,
  initialAcceptState,
  pendingSkips,
  skippedLabel,
  toastActionable,
  topEntry,
  visibleRows,
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
const skipStart = (seq: number, id: string, sendAt = 10_000): AcceptAction => ({
  type: 'skipStarted',
  entry: { seq, kind: 'skip', label: `S${seq}`, item: filed(id), sendAt },
});

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

  test('S, S: each is pending on its own and either can be cancelled', () => {
    let state = run([skipStart(1, 's1'), skipStart(2, 's2')]);
    expect(pendingSkips(state).length).toBe(2);
    state = run([{ type: 'skipCancelled', transactionId: 's1' }], state);
    expect(pendingSkips(state).map((s) => s.item.transactionId)).toEqual(['s2']);
    expect(state.hiddenIds).toEqual(['s2']);
  });

  test('a skip that is sent leaves the stack and its toast goes: Z then reaches the action before it', () => {
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

  test('a skip says it is permanent and for everyone', () => {
    expect(skippedLabel({ subject: 'Uber · –R$ 18,90' })).toBe(
      'Leaving Uber · –R$ 18,90 uncategorized. It will not come back to this list, for anyone in the budget.',
    );
  });
});
