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
const away = { onCategorize: false, activeBudgetId: 'b1' };

describe('leave store', () => {
  test('rows published by the page are held once the route leaves it, and stay in `live`', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a'), entry(2, 'b')]);
    expect(store.holdIfLeft(there)).toBe(false);
    expect(store.holdIfLeft(away)).toBe(true);
    expect(store.getState().held?.entries.length).toBe(2);
    expect(store.getState().live.b1?.length).toBe(2);
  });

  test('a budget switch holds the old budget\'s rows even though the route is still Categorize', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.pageClosed('b1');
    store.publish('b2', []);
    expect(store.holdIfLeft({ onCategorize: true, activeBudgetId: 'b2' })).toBe(true);
    expect(store.getState().held?.budgetId).toBe('b1');
  });

  test('an empty strip never asks anything, and a fresh page clears what an earlier one left', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.publish('b1', []);
    expect(store.holdIfLeft(away)).toBe(false);
  });

  test('one question at a time', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.holdIfLeft(away);
    store.publish('b2', [entry(2, 'b')]);
    expect(store.holdIfLeft(away)).toBe(false);
    expect(store.getState().held?.budgetId).toBe('b1');
  });

  test('Send and leave settles the sent rows and tells a live page; failed rows stay held', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a'), entry(2, 'b')]);
    store.holdIfLeft(away);
    store.settle('sent', ['a']);
    expect(store.getState().held?.entries.map((e) => e.item.transactionId)).toEqual(['b']);
    expect(store.getState().live.b1?.map((e) => e.item.transactionId)).toEqual(['b']);
    expect(store.takeCommands('b1')).toEqual([{ budgetId: 'b1', kind: 'sent', ids: ['a'] }]);
    expect(store.takeCommands('b1')).toEqual([]);
    store.settle('sent', ['b']);
    expect(store.getState().held).toBeNull();
  });

  test('Keep them and leave gives the rows up and tells a live page to drop them', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.holdIfLeft(away);
    store.settle('discard', ['a']);
    expect(store.getState().held).toBeNull();
    expect(store.getState().live.b1).toEqual([]);
    expect(store.takeCommands('b1')).toEqual([{ budgetId: 'b1', kind: 'discard', ids: ['a'] }]);
    expect(store.holdIfLeft(away)).toBe(false);
  });

  test('a page that is gone needs no command', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.pageClosed('b1');
    store.holdIfLeft({ onCategorize: true, activeBudgetId: 'b2' });
    store.settle('discard', ['a']);
    expect(store.takeCommands('b1')).toEqual([]);
  });

  test('commands are for their own budget only', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.holdIfLeft(away);
    store.settle('discard', ['a']);
    expect(store.takeCommands('b2')).toEqual([]);
    expect(store.takeCommands('b1').length).toBe(1);
  });

  test('Stay with a live page needs nothing: its strip is intact', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.holdIfLeft(away);
    expect(store.stay()?.budgetId).toBe('b1');
    expect(store.getState().held).toBeNull();
    expect(store.getState().restore).toBeNull();
    expect(store.getState().live.b1?.length).toBe(1);
    // Leaving again asks again.
    expect(store.holdIfLeft(away)).toBe(true);
  });

  test('Stay with a page that is gone hands the rows to the next page of THEIR budget, once', () => {
    const store = createLeaveStore();
    store.publish('b1', [entry(1, 'a')]);
    store.pageClosed('b1');
    store.holdIfLeft({ onCategorize: true, activeBudgetId: 'b2' });
    expect(store.stay()?.budgetId).toBe('b1');
    expect(store.takeRestore('b2')).toEqual([]);
    expect(store.takeRestore('b1').map((e) => e.item.transactionId)).toEqual(['a']);
    expect(store.takeRestore('b1')).toEqual([]);
  });

  test('listeners hear every change and can unsubscribe', () => {
    const store = createLeaveStore();
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.publish('b1', [entry(1, 'a')]);
    store.pageClosed('b1');
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
