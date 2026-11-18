import { describe, expect, test } from 'bun:test';

import type { Budget, Transaction } from '../../domain/types';
import { mainMenuSections, menuCardPosition, menuCategoryGroups, menuSubLabel } from './txnRowMenu.logic';

const txn = (over: Partial<Transaction> = {}): Transaction =>
  ({ id: 't1', approved: true, cleared: 'uncleared', importId: null, matchedTransactionId: null, repeatRuleId: null, upcoming: false, ...over }) as Transaction;
const ctx = { candidateCount: 1, moveTargetCount: 1, busy: false };
const flat = (t: Transaction, c = ctx) => mainMenuSections(t, c).flat();
const disabled = (t: Transaction, c = ctx) => flat(t, c).filter((i) => i.disabled).map((i) => i.key);

describe('menuSubLabel', () => {
  test('submenu titles; the main list has none', () => {
    expect(menuSubLabel('main')).toBeNull();
    expect((['match', 'repeat', 'move', 'flag', 'category'] as const).map(menuSubLabel)).toEqual([
      'Match', 'Make Repeating', 'Move to Account', 'Flag', 'Categorize',
    ]);
  });
});

describe('mainMenuSections', () => {
  test("YNAB's order, grouped by its dividers", () => {
    expect(mainMenuSections(txn(), ctx).map((s) => s.map((i) => i.key))).toEqual([
      ['approve', 'reject'],
      ['clear', 'unclear'],
      ['match', 'unmatch'],
      ['duplicate', 'repeat', 'flag', 'memo', 'categorize'],
      ['move', 'export'],
      ['delete'],
    ]);
  });
  test('labels, icons, shortcut chips and submenu hints', () => {
    expect(flat(txn()).map((i) => [i.label, i.icon, i.kbd?.join('+') ?? '', !!i.submenu, !!i.danger])).toEqual([
      ['Approve', 'checkmark', 'A', false, false],
      ['Reject', 'close', 'shift+R', false, false],
      ['Mark as Cleared', 'checkmark-circle-outline', 'C', false, false],
      ['Mark as Uncleared', 'ellipse-outline', 'C', false, false],
      ['Match', 'git-compare', 'M', true, false],
      ['Unmatch', 'unlink', 'shift+U', false, false],
      ['Duplicate', 'copy-outline', 'shift+D', false, false],
      ['Make Repeating', 'repeat', 'shift+T', true, false],
      ['Flag', 'flag', '', true, false],
      ['Memo…', 'create-outline', '', false, false],
      ['Categorize', 'pricetag-outline', '', true, false],
      ['Move to Account', 'swap-horizontal', '', true, false],
      ['Export 1 Transaction', 'download-outline', '', false, false],
      ['Delete', 'trash-outline', 'delete', false, true],
    ]);
  });
  test('an approved, uncleared, unmatched manual row', () => {
    expect(disabled(txn())).toEqual(['approve', 'reject', 'unclear', 'unmatch']);
  });
  test('an unapproved imported row can be approved or rejected; a manual one only approved', () => {
    expect(disabled(txn({ approved: false, importId: 'i1' }))).toEqual(['unclear', 'unmatch']);
    expect(disabled(txn({ approved: false }))).toEqual(['reject', 'unclear', 'unmatch']);
  });
  test('cleared flips only toward the other state; reconciled rows flip neither way', () => {
    expect(disabled(txn({ cleared: 'cleared' }))).toEqual(['approve', 'reject', 'clear', 'unmatch']);
    expect(disabled(txn({ cleared: 'reconciled' }))).toEqual(['approve', 'reject', 'clear', 'unclear', 'unmatch']);
  });
  test('match needs a candidate, unmatch a link, move a target', () => {
    expect(disabled(txn({ matchedTransactionId: 'x' }), { ...ctx, candidateCount: 0, moveTargetCount: 0 })).toEqual(['approve', 'reject', 'unclear', 'match', 'move']);
  });
  test('rows on a rule and upcoming occurrences cannot be made repeating', () => {
    expect(disabled(txn({ repeatRuleId: 'r' }))).toContain('repeat');
    expect(disabled(txn({ upcoming: true }))).toContain('repeat');
  });
  test('busy locks every mutation that goes through a pending request', () => {
    expect(disabled(txn({ matchedTransactionId: 'x' }), { ...ctx, busy: true })).toEqual(['approve', 'reject', 'unclear', 'match', 'unmatch', 'duplicate', 'repeat', 'move']);
  });
});

describe('menuCardPosition', () => {
  const win = { w: 1000, h: 800 };
  test('below-right of the pointer: 190 left of it, 6 below', () => {
    expect(menuCardPosition({ x: 500, y: 100 }, win, { w: 250, h: 400 })).toEqual({ left: 310, top: 106 });
  });
  test('clamps to a 12px margin left and right', () => {
    expect(menuCardPosition({ x: 50, y: 100 }, win, { w: 250, h: 400 }).left).toBe(12);
    expect(menuCardPosition({ x: 990, y: 100 }, win, { w: 250, h: 400 }).left).toBe(738);
  });
  test('the bottom clears the 60px chrome; never above 12', () => {
    expect(menuCardPosition({ x: 500, y: 700 }, win, { w: 250, h: 400 }).top).toBe(340);
    expect(menuCardPosition({ x: 500, y: 700 }, { w: 1000, h: 300 }, { w: 250, h: 400 }).top).toBe(12);
  });
  test('before the card is measured it assumes 240 x 320', () => {
    expect(menuCardPosition({ x: 990, y: 700 }, win, null)).toEqual({ left: 748, top: 420 });
  });
});

describe('menuCategoryGroups', () => {
  test('visible categories per group, in group order; empty groups are dropped', () => {
    const budget = {
      groups: [{ id: 'g1', name: 'Bills' }, { id: 'g2', name: 'Empty' }, { id: 'g3', name: 'Fun' }],
      categories: [
        { id: 'c1', groupId: 'g1', name: 'Rent', hidden: false },
        { id: 'c2', groupId: 'g1', name: 'Old', hidden: true },
        { id: 'c3', groupId: 'g2', name: 'Gone', hidden: true },
        { id: 'c4', groupId: 'g3', name: 'Games' },
      ],
    } as unknown as Pick<Budget, 'groups' | 'categories'>;
    expect(menuCategoryGroups(budget)).toEqual([
      { id: 'g1', name: 'Bills', categories: [{ id: 'c1', name: 'Rent' }] },
      { id: 'g3', name: 'Fun', categories: [{ id: 'c4', name: 'Games' }] },
    ]);
  });
});
