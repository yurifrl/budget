import { describe, expect, test } from 'bun:test';

import {
  acceptIdle,
  acceptReducer,
  canUndo,
  filedCountLabel,
  filedLabel,
  hiddenIdSet,
  initialAcceptState,
  skippedLabel,
  visibleRows,
  type AcceptAction,
  type AcceptState,
  type FiledItem,
} from './accept.logic';
import { beginTarget } from './undo.logic';

const filed = (transactionId: string, categoryName = 'Transport'): FiledItem => ({
  transactionId,
  categoryId: `cat-${categoryName}`,
  categoryName,
  subject: `Uber · –R$ 18,90`,
});

const run = (actions: AcceptAction[], from: AcceptState = initialAcceptState) =>
  actions.reduce(acceptReducer, from);

const done = (ids: string[], label = 'x', showToast = true): AcceptAction => ({
  type: 'succeeded',
  transactionIds: ids,
  requestIds: ids,
  label,
  showToast,
});

describe('accepting', () => {
  test('start hides the filed rows and keeps them pending', () => {
    const state = run([{ type: 'start', items: [filed('t1'), filed('t2')] }]);
    expect(state.hiddenIds).toEqual(['t1', 't2']);
    expect(state.pending.map((item) => item.transactionId)).toEqual(['t1', 't2']);
    expect(state.toast).toBeNull();
    expect(acceptIdle(state)).toBe(false);
  });

  test('a failure restores only the rows the failed request hid', () => {
    const state = run([
      { type: 'start', items: [filed('t1')] },
      { type: 'start', items: [filed('t2')] },
      { type: 'failed', error: 'Server down', requestIds: ['t1'] },
    ]);
    expect(state.hiddenIds).toEqual(['t2']);
    expect(state.pending.map((item) => item.transactionId)).toEqual(['t2']);
    expect(state.error).toBe('Server down');
    expect(acceptIdle(state)).toBe(false);
  });

  test('a success keeps the rows hidden and turns the accept into an undo toast', () => {
    const state = run([{ type: 'start', items: [filed('t1')] }, done(['t1'], 'Uber → Transport')]);
    expect(state.hiddenIds).toEqual(['t1']);
    expect(state.pending).toEqual([]);
    expect(state.toast).toEqual({ label: 'Uber → Transport', actionable: true });
    expect(acceptIdle(state)).toBe(true);
  });

  test('a batch that went through only in part keeps the accepted rows and says so, counting one request', () => {
    const state = run([
      { type: 'start', items: [] },
      { type: 'succeeded', transactionIds: ['t1'], requestIds: [], label: '1 filed', showToast: true, error: 'Half' },
    ]);
    expect(state.hiddenIds).toEqual(['t1']);
    expect(state.error).toBe('Half');
    expect(state.toast?.label).toBe('1 filed');
    expect(acceptIdle(state)).toBe(true);
  });

  test('a late answer for an earlier press does not take the toast of the latest', () => {
    const state = run([
      { type: 'start', items: [filed('a')] },
      { type: 'start', items: [filed('b')] },
      done(['b'], 'B'),
      done(['a'], 'A', false),
    ]);
    expect(state.toast?.label).toBe('B');
    expect(state.hiddenIds.sort()).toEqual(['a', 'b']);
    expect(acceptIdle(state)).toBe(true);
  });
});

describe('undoable target', () => {
  test('Undo is offered as soon as the press happened, before the server answered', () => {
    const state = run([
      { type: 'start', items: [filed('t1')] },
      { type: 'setUndoable', target: beginTarget(1, 'accept', 'x', ['t1']) },
    ]);
    expect(canUndo(state)).toBe(true);
    expect(acceptIdle(state)).toBe(false);
  });

  test('the target outlives its toast', () => {
    const state = run([
      { type: 'setUndoable', target: beginTarget(1, 'accept', 'x', ['t1']) },
      done(['t1']),
      { type: 'dismissToast' },
    ]);
    expect(state.toast).toBeNull();
    expect(canUndo(state)).toBe(true);
  });
});

describe('undo outcome', () => {
  const accepted = () =>
    run([
      { type: 'setUndoable', target: beginTarget(1, 'accept', 'x', ['t1', 't2']) },
      done(['t1', 't2']),
      { type: 'undoStarted' },
    ]);

  test('a full undo un-hides the rows, drops the target and says how many', () => {
    const state = acceptReducer(accepted(), {
      type: 'undoFinished',
      restoredIds: ['t1', 't2'],
      undoable: null,
      message: 'Undid 2 transactions.',
      tone: 'ok',
    });
    expect(state.hiddenIds).toEqual([]);
    expect(state.toast).toEqual({ label: 'Undid 2 transactions.', actionable: false });
    expect(state.error).toBeNull();
    expect(canUndo(state)).toBe(false);
    expect(acceptIdle(state)).toBe(true);
  });

  test('a partial undo is an error line, not a success, and keeps what was not reached undoable', () => {
    const rest = beginTarget(1, 'accept', 'x', ['t2']);
    const state = acceptReducer(accepted(), {
      type: 'undoFinished',
      restoredIds: ['t1'],
      undoable: rest,
      message: 'Undid 1 of 2 transactions. 1 could not be undone right now: try Undo again.',
      tone: 'problem',
    });
    expect(state.hiddenIds).toEqual(['t2']);
    expect(state.toast).toBeNull();
    expect(state.error).toContain('Undid 1 of 2');
    expect(state.undoable).toBe(rest);
  });
});

describe('skip is pending until its window runs out', () => {
  test('hides the row and offers Undo without sending anything', () => {
    const state = run([{ type: 'skipStarted', item: filed('s1'), label: 'Leaving Uber uncategorized' }]);
    expect(state.hiddenIds).toEqual(['s1']);
    expect(state.toast).toEqual({ label: 'Leaving Uber uncategorized', actionable: true });
    expect(acceptIdle(state)).toBe(true);
    expect(state.pending).toEqual([]);
  });

  test('Undo inside the window puts the row back and clears the toast', () => {
    const state = run([
      { type: 'skipStarted', item: filed('s1'), label: 'x' },
      { type: 'skipCancelled', transactionId: 's1' },
    ]);
    expect(state.hiddenIds).toEqual([]);
    expect(state.toast).toBeNull();
  });

  test('sending marks it in flight; success keeps the row hidden', () => {
    const state = run([
      { type: 'skipStarted', item: filed('s1'), label: 'x' },
      { type: 'skipSending', item: filed('s1') },
    ]);
    expect(acceptIdle(state)).toBe(false);
    const sent = acceptReducer(state, { type: 'skipDone', requestId: 's1' });
    expect(sent.hiddenIds).toEqual(['s1']);
    expect(acceptIdle(sent)).toBe(true);
  });

  test('a failed send brings the row back with the error', () => {
    const state = run([
      { type: 'skipStarted', item: filed('s1'), label: 'x' },
      { type: 'skipSending', item: filed('s1') },
      { type: 'failed', error: 'No', requestIds: ['s1'] },
    ]);
    expect(state.hiddenIds).toEqual([]);
    expect(state.error).toBe('No');
    expect(acceptIdle(state)).toBe(true);
  });

  test('the sentence says it is permanent and for everyone', () => {
    expect(skippedLabel({ subject: 'Uber · –R$ 18,90' })).toBe(
      'Leaving Uber · –R$ 18,90 uncategorized. It will not come back to this list, for anyone in the budget.',
    );
  });
});

describe('prune and visibility', () => {
  test('drops hidden ids the queue no longer lists, keeps listed and in-flight ones', () => {
    const state = run([
      done(['t1', 't2']),
      { type: 'start', items: [filed('t3')] },
      { type: 'prune', presentIds: ['t2'] },
    ]);
    expect(state.hiddenIds.sort()).toEqual(['t2', 't3']);
  });

  test('returns the same state when nothing is dropped', () => {
    const state = run([done(['t1'])]);
    expect(acceptReducer(state, { type: 'prune', presentIds: ['t1'] })).toBe(state);
  });

  test('visibleRows drops the hidden ids', () => {
    const rows = [{ transaction_id: 't1' }, { transaction_id: 't2' }, { transaction_id: 't3' }];
    expect(visibleRows(rows, hiddenIdSet({ hiddenIds: ['t2'] })).map((r) => r.transaction_id)).toEqual(['t1', 't3']);
    expect(visibleRows(rows, hiddenIdSet({ hiddenIds: [] }))).toEqual(rows);
  });

  test('clearing an error keeps the toast and the hidden rows; reset forgets everything', () => {
    const state = run([done(['t1']), { type: 'undoStarted' }]);
    expect(acceptReducer(state, { type: 'clearError' }).hiddenIds).toEqual(['t1']);
    expect(acceptReducer(state, { type: 'reset' })).toEqual(initialAcceptState);
  });
});

describe('toast sentences', () => {
  test('single row names the subject and the category', () => {
    expect(filedLabel({ subject: 'Uber · –R$ 18,90', categoryName: 'Transport' })).toBe('Uber · –R$ 18,90 → Transport');
  });

  test('a batch counts its transactions', () => {
    expect(filedCountLabel(1)).toBe('1 transaction filed');
    expect(filedCountLabel(96)).toBe('96 transactions filed');
  });
});
