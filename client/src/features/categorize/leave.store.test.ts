import { describe, expect, test } from 'bun:test';

import type { SkipEntry } from './accept.logic';
import { createLeaveStore } from './leave.store';

const entry = (seq: number, id: string): SkipEntry => ({
  seq,
  kind: 'skip',
  label: `S${seq}`,
  item: { transactionId: id, categoryId: '', categoryName: '', subject: id },
  meta: { payeeId: null, topCategoryId: null, amount: 0 },
});

describe('leave store', () => {
  test('a page that leaves with rows in its strip holds them; an empty strip holds nothing', () => {
    const store = createLeaveStore();
    store.hold({ budgetId: 'b1', entries: [] });
    expect(store.getState().held).toBeNull();
    store.hold({ budgetId: 'b1', entries: [entry(1, 'a'), entry(2, 'b')] });
    expect(store.getState().held?.entries.length).toBe(2);
  });

  test('Send and leave / Keep and leave clear the held rows', () => {
    const store = createLeaveStore();
    store.hold({ budgetId: 'b1', entries: [entry(1, 'a')] });
    store.clearHeld();
    expect(store.getState()).toEqual({ held: null, restore: null });
  });

  test('a send that failed for some keeps only those for another try', () => {
    const store = createLeaveStore();
    store.hold({ budgetId: 'b1', entries: [entry(1, 'a'), entry(2, 'b')] });
    store.narrow([entry(2, 'b')]);
    expect(store.getState().held?.entries.map((e) => e.item.transactionId)).toEqual(['b']);
    store.narrow([]);
    expect(store.getState().held).toBeNull();
  });

  test('Stay hands the rows to the next page of THEIR budget, once', () => {
    const store = createLeaveStore();
    store.hold({ budgetId: 'b1', entries: [entry(1, 'a')] });
    expect(store.stay()?.budgetId).toBe('b1');
    expect(store.getState().held).toBeNull();
    expect(store.takeRestore('b2')).toEqual([]);
    expect(store.takeRestore('b1').map((e) => e.item.transactionId)).toEqual(['a']);
    expect(store.takeRestore('b1')).toEqual([]);
  });

  test('listeners hear every change and can unsubscribe', () => {
    const store = createLeaveStore();
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.hold({ budgetId: 'b1', entries: [entry(1, 'a')] });
    store.clearHeld();
    off();
    store.hold({ budgetId: 'b1', entries: [entry(1, 'a')] });
    expect(calls).toBe(2);
  });
});
