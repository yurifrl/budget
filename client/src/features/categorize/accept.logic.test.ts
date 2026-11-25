import { describe, expect, test } from 'bun:test';

import {
  acceptIdle,
  acceptReducer,
  canUndo,
  filedCountLabel,
  filedLabel,
  hiddenIdSet,
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
    expect(state.pending?.map((item) => item.transactionId)).toEqual(['t1', 't2']);
    expect(state.toast).toBeNull();
    expect(state.error).toBeNull();
    expect(acceptIdle(state)).toBe(false);
  });

  test('a failure restores only the rows the failed accept hid', () => {
    const state = acceptReducer(initialAcceptState, { type: 'start', items: [filed('t1'), filed('t2')] });
    const failed = acceptReducer(state, { type: 'failed', error: 'Server down' });
    expect(failed.hiddenIds).toEqual([]);
    expect(failed.pending).toBeNull();
    expect(failed.error).toBe('Server down');
    expect(acceptIdle(failed)).toBe(true);
  });

  test('a success keeps the rows hidden and turns the accept into an undo toast', () => {
    const state = acceptReducer(initialAcceptState, { type: 'start', items: [filed('t1')] });
    const done = acceptReducer(state, {
      type: 'succeeded',
      transactionIds: ['t1'],
      label: 'Uber · –R$ 18,90 → Transport',
    });
    expect(done.hiddenIds).toEqual(['t1']);
    expect(done.pending).toBeNull();
    expect(done.toast).toEqual({ label: 'Uber · –R$ 18,90 → Transport', transactionIds: ['t1'] });
    expect(canUndo(done)).toBe(true);
  });

  test('undo un-hides exactly the rows the server restored', () => {
    const accepted = acceptReducer(initialAcceptState, {
      type: 'succeeded',
      transactionIds: ['t1', 't2'],
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

  test('dismissing the toast leaves the accepted rows hidden', () => {
    const accepted = acceptReducer(initialAcceptState, {
      type: 'succeeded',
      transactionIds: ['t1'],
      label: 'Uber → Transport',
    });
    const dismissed = acceptReducer(accepted, { type: 'dismissToast' });
    expect(dismissed.toast).toBeNull();
    expect(dismissed.hiddenIds).toEqual(['t1']);
  });

  test('clearing an error keeps the toast and the hidden rows', () => {
    const failed = acceptReducer(
      acceptReducer(initialAcceptState, { type: 'succeeded', transactionIds: ['t1'], label: 'x' }),
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
