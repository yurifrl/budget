import { describe, expect, test } from 'bun:test';

import type { SkipEntry } from './accept.logic';
import { createLeaveStore, onCategorizeRoute } from './leave.store';

const entry = (seq: number, id: string): SkipEntry => ({
  seq,
  kind: 'skip',
  label: `S${seq}`,
  item: { transactionId: id, categoryId: '', categoryName: '', subject: id },
  meta: { payeeId: null, topCategoryId: null, amount: 0 },
});

const there = { onCategorize: true, activeBudgetId: 'b1' };

describe('leave store', () => {
  test('rows published by the page are held once the route leaves it', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a'), entry(2, 'b')]);
    expect(store.holdIfLeft(there)).toBe(false);
    expect(store.holdIfLeft({ onCategorize: false, activeBudgetId: 'b1' })).toBe(true);
    expect(store.getState().held).toEqual({ budgetId: 'b1', entries: [entry(1, 'a'), entry(2, 'b')] });
    expect(store.getState().live).toEqual({});
  });

  test('a budget switch holds the old budget\'s rows even though the route is still Categorize', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.publish('b2', []);
    expect(store.holdIfLeft({ onCategorize: true, activeBudgetId: 'b2' })).toBe(true);
    expect(store.getState().held?.budgetId).toBe('b1');
  });

  test('an empty strip never asks anything, and a fresh page clears what an earlier one left', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.publish('b1', []);
    expect(store.holdIfLeft({ onCategorize: false, activeBudgetId: 'b1' })).toBe(false);
  });

  test('one question at a time', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.holdIfLeft({ onCategorize: false, activeBudgetId: 'b1' });
    store.publish('b2', [entry(2, 'b')]);
    expect(store.holdIfLeft({ onCategorize: false, activeBudgetId: 'b1' })).toBe(false);
    expect(store.getState().held?.budgetId).toBe('b1');
  });

  test('Send and leave / Keep and leave clear the held rows', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.holdIfLeft({ onCategorize: false, activeBudgetId: 'b1' });
    store.clearHeld();
    expect(store.getState().held).toBeNull();
    expect(store.getState().restore).toBeNull();
  });

  test('a send that failed for some keeps only those for another try', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a'), entry(2, 'b')]);
    store.holdIfLeft({ onCategorize: false, activeBudgetId: 'b1' });
    store.narrow([entry(2, 'b')]);
    expect(store.getState().held?.entries.map((e) => e.item.transactionId)).toEqual(['b']);
    store.narrow([]);
    expect(store.getState().held).toBeNull();
  });

  test('Stay hands the rows to the next page of THEIR budget, once', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.holdIfLeft({ onCategorize: false, activeBudgetId: 'b1' });
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
    store.publish('b1', [entry(1, 'a')]);
    store.clearHeld();
    off();
    store.publish('b1', []);
    expect(calls).toBe(2);
  });
});

describe('onCategorizeRoute', () => {
  test('the page and anything below it', () => {
    expect(onCategorizeRoute('/categorize')).toBe(true);
    expect(onCategorizeRoute('/categorize/x')).toBe(true);
    expect(onCategorizeRoute('/plan')).toBe(false);
    expect(onCategorizeRoute('/categorized')).toBe(false);
  });
});
