import { describe, expect, test } from 'bun:test';

import {
  allRowsSelected,
  duplicateDraft,
  rowPressIntent,
  selectionAllCleared,
  selectionCanMatch,
  selectionMoveTargets,
  selectionShortcut,
  selectRange,
  toggleAllVisible,
  toggleId,
  unmatchTargets,
} from './registerSelection';
import type { Account, Transaction } from './types';

const row = (id: string, over: Partial<Transaction> = {}): Transaction =>
  ({ id, accountId: 'a1', cleared: 'uncleared', approved: true, ...over }) as Transaction;
const rows = ['r0', 'r1', 'r2', 'r3', 'r4'].map((id) => row(id));
const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe('toggleId', () => {
  test('adds a missing id, removes a present one, never mutates', () => {
    const prev = new Set(['a']);
    expect(sorted(toggleId(prev, 'b'))).toEqual(['a', 'b']);
    expect(sorted(toggleId(prev, 'a'))).toEqual([]);
    expect(sorted(prev)).toEqual(['a']);
  });
});

describe('selectRange (shift-click)', () => {
  test('selects everything between the anchor and the clicked row, either direction', () => {
    expect(sorted(selectRange(new Set(), rows, 'r1', 'r3'))).toEqual(['r1', 'r2', 'r3']);
    expect(sorted(selectRange(new Set(), rows, 'r3', 'r1'))).toEqual(['r1', 'r2', 'r3']);
  });
  test('unions into the existing selection', () => {
    expect(sorted(selectRange(new Set(['r4', 'zz']), rows, 'r0', 'r1'))).toEqual(['r0', 'r1', 'r4', 'zz']);
  });
  test('no anchor, or an anchor no longer visible, ranges from the first row', () => {
    expect(sorted(selectRange(new Set(), rows, null, 'r2'))).toEqual(['r0', 'r1', 'r2']);
    expect(sorted(selectRange(new Set(), rows, 'hidden', 'r2'))).toEqual(['r0', 'r1', 'r2']);
  });
  test('a clicked row that is not in the list (index -1) selects only up to the anchor', () => {
    // lo = min(-1, anchor) = -1, hi = anchor: rows[-1] is skipped.
    expect(sorted(selectRange(new Set(), rows, 'r1', 'nope'))).toEqual(['r0', 'r1']);
  });
});

describe('select all', () => {
  test('allRowsSelected: every visible row checked; false for an empty register', () => {
    expect(allRowsSelected(rows, new Set(rows.map((r) => r.id)))).toBe(true);
    expect(allRowsSelected(rows, new Set(['r0']))).toBe(false);
    expect(allRowsSelected([], new Set(['r0']))).toBe(false);
  });
  test('checking unions the visible rows into the selection', () => {
    expect(sorted(toggleAllVisible(new Set(['hidden']), rows.slice(0, 2), false))).toEqual(['hidden', 'r0', 'r1']);
  });
  test('unchecking removes only the visible rows, keeping hidden selections', () => {
    expect(sorted(toggleAllVisible(new Set(['hidden', 'r0', 'r1']), rows.slice(0, 2), true))).toEqual(['hidden']);
  });
});

describe('selection flags', () => {
  test('allCleared: non-empty and nothing uncleared (reconciled counts as cleared)', () => {
    expect(selectionAllCleared([])).toBe(false);
    expect(selectionAllCleared([row('a', { cleared: 'cleared' }), row('b', { cleared: 'reconciled' })])).toBe(true);
    expect(selectionAllCleared([row('a', { cleared: 'cleared' }), row('b')])).toBe(false);
  });
  test('canMatch: exactly two unmatched rows where the second is a candidate of the first', () => {
    const a = row('a');
    const b = row('b');
    const yes = () => [b];
    const no = () => [] as Transaction[];
    expect(selectionCanMatch([a, b], yes)).toBe(true);
    expect(selectionCanMatch([a, b], no)).toBe(false);
    expect(selectionCanMatch([a], yes)).toBe(false);
    expect(selectionCanMatch([a, b, row('c')], yes)).toBe(false);
    expect(selectionCanMatch([row('a', { matchedTransactionId: 'x' }), b], yes)).toBe(false);
    expect(selectionCanMatch([a, row('b', { matchedTransactionId: 'x' })], yes)).toBe(false);
  });
  test('canMatch asks for the candidates of the first selected row', () => {
    const seen: string[] = [];
    selectionCanMatch([row('a'), row('b')], (t) => {
      seen.push(t.id);
      return [];
    });
    expect(seen).toEqual(['a']);
  });
});

describe('selectionMoveTargets', () => {
  const accounts = [
    { id: 'a1', name: 'Checking', group: 'CASH' },
    { id: 'a2', name: 'Card', group: 'CREDIT' },
    { id: 'a3', name: 'Old', group: 'CLOSED' },
  ] as unknown as Account[];
  test('open accounts none of the selected rows already sit in', () => {
    expect(selectionMoveTargets(accounts, [row('x', { accountId: 'a1' })])).toEqual([{ id: 'a2', name: 'Card', disabled: false }]);
    expect(selectionMoveTargets(accounts, [row('x', { accountId: 'a1' }), row('y', { accountId: 'a2' })])).toEqual([]);
    expect(selectionMoveTargets(accounts, [])).toEqual([
      { id: 'a1', name: 'Checking', disabled: false },
      { id: 'a2', name: 'Card', disabled: false },
    ]);
  });
});

describe('unmatchTargets', () => {
  test('each matched row, then its partner unless the partner is selected too', () => {
    const sel = [row('a', { matchedTransactionId: 'p' }), row('b'), row('c', { matchedTransactionId: 'd' }), row('d', { matchedTransactionId: 'c' })];
    expect(unmatchTargets(sel, new Set(['a', 'b', 'c', 'd']))).toEqual(['a', 'p', 'c', 'd']);
  });
});

describe('duplicateDraft', () => {
  test('copies the row, defaulting a missing memo and flag', () => {
    const t = row('a', {
      accountId: 'a9', date: '2026-01-02', payee: 'Shop', categoryId: 'c1', memo: undefined as unknown as string,
      outflow: 5, inflow: 0, cleared: 'cleared', approved: false, repeat: 'monthly',
    });
    expect(duplicateDraft(t)).toEqual({
      accountId: 'a9', date: '2026-01-02', payee: 'Shop', categoryId: 'c1', memo: '',
      outflowCents: 5, inflowCents: 0, cleared: 'cleared', approved: false, flag: null, repeat: 'monthly',
    });
    expect(duplicateDraft({ ...t, flag: 'red', memo: 'm' }).flag).toBe('red');
    expect(duplicateDraft({ ...t, flag: 'red', memo: 'm' }).memo).toBe('m');
  });
});

describe('rowPressIntent', () => {
  const none = { ctrlKey: false, metaKey: false, shiftKey: false };
  test('plain click (and any native press) opens the editor', () => {
    expect(rowPressIntent(true, none)).toBe('open');
    expect(rowPressIntent(true, {})).toBe('open');
    expect(rowPressIntent(false, { shiftKey: true, ctrlKey: true })).toBe('open');
  });
  test('shift ranges (even with ctrl/cmd); ctrl or cmd alone toggles', () => {
    expect(rowPressIntent(true, { ...none, shiftKey: true })).toBe('range');
    expect(rowPressIntent(true, { ctrlKey: true, metaKey: false, shiftKey: true })).toBe('range');
    expect(rowPressIntent(true, { ...none, ctrlKey: true })).toBe('toggle');
    expect(rowPressIntent(true, { ...none, metaKey: true })).toBe('toggle');
  });
});

describe('selectionShortcut', () => {
  const key = (k: string, over: Record<string, boolean> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
  const flags = { allCleared: false, hasMatched: true, canMatch: true };
  test('cmd/ctrl/alt chords are never claimed', () => {
    expect(selectionShortcut(key('c', { metaKey: true }), flags)).toBeNull();
    expect(selectionShortcut(key('c', { ctrlKey: true }), flags)).toBeNull();
    expect(selectionShortcut(key('Delete', { altKey: true }), flags)).toBeNull();
  });
  test('C flips cleared by the all-cleared flag, with or without shift', () => {
    expect(selectionShortcut(key('c'), flags)).toEqual({ kind: 'clear', cleared: 'cleared' });
    expect(selectionShortcut(key('C', { shiftKey: true }), { ...flags, allCleared: true })).toEqual({ kind: 'clear', cleared: 'uncleared' });
  });
  test('shift+U unmatches only when something is matched', () => {
    expect(selectionShortcut(key('U', { shiftKey: true }), flags)).toEqual({ kind: 'unmatch' });
    expect(selectionShortcut(key('u', { shiftKey: true }), { ...flags, hasMatched: false })).toBeNull();
    expect(selectionShortcut(key('u'), flags)).toBeNull();
  });
  test('shift+D duplicates; plain d does nothing', () => {
    expect(selectionShortcut(key('D', { shiftKey: true }), flags)).toEqual({ kind: 'duplicate' });
    expect(selectionShortcut(key('d'), flags)).toBeNull();
  });
  test('M matches only without shift and only when matchable', () => {
    expect(selectionShortcut(key('m'), flags)).toEqual({ kind: 'match' });
    expect(selectionShortcut(key('M', { shiftKey: true }), flags)).toBeNull();
    expect(selectionShortcut(key('m'), { ...flags, canMatch: false })).toBeNull();
  });
  test('Delete and Backspace delete (shift too)', () => {
    expect(selectionShortcut(key('Delete'), flags)).toEqual({ kind: 'delete' });
    expect(selectionShortcut(key('Backspace', { shiftKey: true }), flags)).toEqual({ kind: 'delete' });
  });
  test('other keys are ignored', () => {
    expect(selectionShortcut(key('x'), flags)).toBeNull();
  });
});
