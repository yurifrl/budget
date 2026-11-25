import { describe, expect, test } from 'bun:test';

import {
  acceptIdle,
  acceptReducer,
  canUndo,
  filedCountLabel,
  filedLabel,
  hiddenIdSet,
  skippedLabel,
  initialAcceptState,
  visibleRows,
  type FiledItem,
} from './accept.logic';

const filed = (transactionId: string, categoryName = 'Transport'): FiledItem => ({
  transactionId,
  categoryId: `cat-${categoryName}`,
  categoryName,
  subject: `Uber · –R$ 18,90`,
});

describe('acceptReducer', () => {
  test('start hides the filed rows and keeps them pending', () => {
    const state = acceptReducer(initialAcceptState, { type: 'start', items: [filed('t1'), filed('t2')] });
    expect(state.hiddenIds).toEqual(['t1', 't2']);
    expect(state.pending.map((item) => item.transactionId)).toEqual(['t1', 't2']);
    expect(state.toast).toBeNull();
    expect(state.error).toBeNull();
    expect(acceptIdle(state)).toBe(false);
  });

  test('a failure restores only the rows the failed accept hid', () => {
    const state = acceptReducer(initialAcceptState, { type: 'start', items: [filed('t1'), filed('t2')] });
    const failed = acceptReducer(state, { type: 'failed', error: 'Server down', requestIds: ['t1', 't2'] });
    expect(failed.hiddenIds).toEqual([]);
    expect(failed.pending).toEqual([]);
    expect(failed.error).toBe('Server down');
    expect(acceptIdle(failed)).toBe(true);
  });

  test('a success keeps the rows hidden and turns the accept into an undo toast', () => {
    const state = acceptReducer(initialAcceptState, { type: 'start', items: [filed('t1')] });
    const done = acceptReducer(state, {
      type: 'succeeded',
      transactionIds: ['t1'],
      requestIds: ['t1'],
      label: 'Uber · –R$ 18,90 → Transport',
    });
    expect(done.hiddenIds).toEqual(['t1']);
    expect(done.pending).toEqual([]);
    expect(done.toast).toEqual({ label: 'Uber · –R$ 18,90 → Transport', transactionIds: ['t1'] });
    expect(canUndo(done)).toBe(true);
  });

  test('undo un-hides exactly the rows the server restored', () => {
    const accepted = acceptReducer(initialAcceptState, {
      type: 'succeeded',
      transactionIds: ['t1', 't2'],
      requestIds: [],
      label: '2 filed',
    });
    const undoing = acceptReducer(accepted, { type: 'undoStarted' });
    expect(canUndo(undoing)).toBe(false);
    const undone = acceptReducer(undoing, {
      type: 'undoSucceeded',
      transactionIds: ['t1'],
      restored: 1,
      skipped: 1,
    });
    expect(undone.hiddenIds).toEqual(['t2']);
    expect(undone.toast).toBeNull();
    expect(undone.lastUndo).toEqual({ restored: 1, skipped: 1 });
    expect(undoing.toast).not.toBeNull();
  });

  test('a failed undo keeps the toast so it can be tried again', () => {
    const accepted = acceptReducer(initialAcceptState, {
      type: 'succeeded',
      transactionIds: ['t1'],
      requestIds: [],
      label: 'Uber → Transport',
    });
    const failed = acceptReducer(acceptReducer(accepted, { type: 'undoStarted' }), {
      type: 'undoFailed',
      error: 'Could not undo',
    });
    expect(failed.toast?.transactionIds).toEqual(['t1']);
    expect(failed.error).toBe('Could not undo');
    expect(canUndo(failed)).toBe(true);
  });

  test('the last accept stays undoable after its toast times out, until the next accept or an undo', () => {
    let state = acceptReducer(initialAcceptState, { type: 'succeeded', transactionIds: ['t1'], requestIds: [], label: 'a' });
    state = acceptReducer(state, { type: 'dismissToast' });
    expect(state.toast).toBeNull();
    expect(canUndo(state)).toBe(true);
    state = acceptReducer(state, { type: 'skipSucceeded', requestId: 'x', label: 'skipped' });
    expect(canUndo(state)).toBe(true);
    const started = acceptReducer(state, { type: 'start', items: [filed('t2')] });
    expect(started.undoable?.transactionIds).toEqual(['t1']);
    const replaced = acceptReducer(started, { type: 'succeeded', transactionIds: ['t2'], requestIds: ['t2'], label: 'b' });
    expect(replaced.undoable?.transactionIds).toEqual(['t2']);
    const undone = acceptReducer(replaced, { type: 'undoSucceeded', transactionIds: ['t2'], restored: 1, skipped: 0 });
    expect(canUndo(undone)).toBe(false);
  });

  test('dismissing the toast leaves the accepted rows hidden', () => {
    const accepted = acceptReducer(initialAcceptState, {
      type: 'succeeded',
      transactionIds: ['t1'],
      requestIds: [],
      label: 'Uber → Transport',
    });
    const dismissed = acceptReducer(accepted, { type: 'dismissToast' });
    expect(dismissed.toast).toBeNull();
    expect(dismissed.hiddenIds).toEqual(['t1']);
  });

  test('clearing an error keeps the toast and the hidden rows', () => {
    const failed = acceptReducer(
      acceptReducer(initialAcceptState, { type: 'succeeded', transactionIds: ['t1'], requestIds: [], label: 'x' }),
      { type: 'undoFailed', error: 'Nope' },
    );
    const cleared = acceptReducer(failed, { type: 'clearError' });
    expect(cleared.error).toBeNull();
    expect(cleared.toast?.transactionIds).toEqual(['t1']);
    expect(cleared.hiddenIds).toEqual(['t1']);
  });

  test('reset forgets everything', () => {
    const accepted = acceptReducer(initialAcceptState, {
      type: 'start',
      items: [filed('t1')],
    });
    expect(acceptReducer(accepted, { type: 'reset' })).toEqual(initialAcceptState);
  });
});

describe('overlapping single-row filings (keyboard flow)', () => {
  test('a failure restores only its own row; the other stays hidden and in flight', () => {
    let state = acceptReducer(initialAcceptState, { type: 'start', items: [filed('t1')] });
    state = acceptReducer(state, { type: 'start', items: [filed('t2')] });
    expect(state.busy).toBe(2);
    state = acceptReducer(state, { type: 'failed', error: 'Nope', requestIds: ['t1'] });
    expect(state.hiddenIds).toEqual(['t2']);
    expect(state.pending.map((item) => item.transactionId)).toEqual(['t2']);
    expect(acceptIdle(state)).toBe(false);
    state = acceptReducer(state, { type: 'succeeded', transactionIds: ['t2'], requestIds: ['t2'], label: 'x' });
    expect(acceptIdle(state)).toBe(true);
    expect(state.toast?.transactionIds).toEqual(['t2']);
  });

  test('a second filing starts while the first toast is still up and replaces it', () => {
    let state = acceptReducer(initialAcceptState, { type: 'succeeded', transactionIds: ['t1'], requestIds: [], label: 'a' });
    state = acceptReducer(state, { type: 'start', items: [filed('t2')] });
    expect(state.toast).toBeNull();
    state = acceptReducer(state, { type: 'succeeded', transactionIds: ['t2'], requestIds: ['t2'], label: 'b' });
    expect(state.hiddenIds).toEqual(['t1', 't2']);
    expect(state.toast?.label).toBe('b');
  });
});

describe('skip', () => {
  test('hides the row, keeps the current undo toast, and the toast it leaves has no Undo', () => {
    const accepted = acceptReducer(initialAcceptState, { type: 'succeeded', transactionIds: ['t1'], requestIds: [], label: 'a' });
    const skipping = acceptReducer(accepted, { type: 'skipStarted', item: filed('t2') });
    expect(skipping.hiddenIds).toEqual(['t1', 't2']);
    expect(skipping.toast?.transactionIds).toEqual(['t1']);
    const done = acceptReducer(skipping, { type: 'skipSucceeded', requestId: 't2', label: 'Skipped Uber' });
    expect(done.toast).toEqual({ label: 'Skipped Uber', transactionIds: [] });
    // The earlier accept is still what Z reverses; a skip has nothing to undo.
    expect(done.undoable?.transactionIds).toEqual(['t1']);
    expect(acceptIdle(done)).toBe(true);
  });

  test('a failed skip brings the row back', () => {
    const skipping = acceptReducer(initialAcceptState, { type: 'skipStarted', item: filed('t2') });
    const failed = acceptReducer(skipping, { type: 'failed', error: 'x', requestIds: ['t2'] });
    expect(failed.hiddenIds).toEqual([]);
    expect(acceptIdle(failed)).toBe(true);
  });

  test('the sentence names the subject', () => {
    expect(skippedLabel({ subject: 'Uber · –R$ 18,90' })).toBe('Skipped Uber · –R$ 18,90. It stays uncategorized in the register.');
  });
});

describe('prune', () => {
  test('drops hidden ids the queue no longer lists, keeps listed and in-flight ones', () => {
    let state = acceptReducer(initialAcceptState, { type: 'succeeded', transactionIds: ['t1', 't2'], requestIds: [], label: 'x' });
    state = acceptReducer(state, { type: 'start', items: [filed('t3')] });
    const pruned = acceptReducer(state, { type: 'prune', presentIds: ['t2'] });
    expect(pruned.hiddenIds.sort()).toEqual(['t2', 't3']);
  });

  test('returns the same state when nothing is dropped', () => {
    const state = acceptReducer(initialAcceptState, { type: 'succeeded', transactionIds: ['t1'], requestIds: [], label: 'x' });
    expect(acceptReducer(state, { type: 'prune', presentIds: ['t1'] })).toBe(state);
  });
});

describe('queue visibility helpers', () => {
  const rows = [{ transaction_id: 't1' }, { transaction_id: 't2' }, { transaction_id: 't3' }];

  test('visibleRows drops the hidden ids', () => {
    expect(visibleRows(rows, hiddenIdSet({ hiddenIds: ['t2'] })).map((r) => r.transaction_id)).toEqual(['t1', 't3']);
  });

  test('an empty hidden set keeps every row', () => {
    expect(visibleRows(rows, hiddenIdSet({ hiddenIds: [] }))).toEqual(rows);
  });
});

describe('toast sentences', () => {
  test('single row names the subject and the category', () => {
    expect(filedLabel({ subject: 'Uber · –R$ 18,90', categoryName: 'Transport' })).toBe(
      'Uber · –R$ 18,90 → Transport',
    );
  });

  test('a batch counts its transactions', () => {
    expect(filedCountLabel(1)).toBe('1 transaction filed');
    expect(filedCountLabel(96)).toBe('96 transactions filed');
  });
});
