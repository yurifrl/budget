import { describe, expect, test } from 'bun:test';

import type { AccountRow } from '../../data/rows';
import { fallbackBudgetId, railAccountBalance, railSections, railSectionTotal } from './rail.logic';

const acc = (id: string, account_group: AccountRow['account_group'], type: AccountRow['type']) => ({ id, account_group, type });

describe('railSections', () => {
  const accounts = [
    acc('cc', 'CREDIT', 'creditCard'),
    acc('old', 'CLOSED', 'checking'),
    acc('sav', 'CASH', 'savings'),
    acc('chk1', 'CASH', 'checking'),
    acc('wallet', 'CASH', 'cash'),
    acc('chk2', 'CASH', 'checking'),
    acc('loc', 'CREDIT', 'lineOfCredit'),
  ];

  test('cash splits per type in first-seen order, then CREDIT; CLOSED hidden by default', () => {
    const sections = railSections(accounts, false);
    expect(sections.map((s) => [s.key, s.label, s.accs.map((a) => a.id)])).toEqual([
      ['CASH:savings', 'Savings', ['sav']],
      ['CASH:checking', 'Checking', ['chk1', 'chk2']],
      ['CASH:cash', 'Cash', ['wallet']],
      ['CREDIT', 'Credit Cards', ['cc', 'loc']],
    ]);
  });

  test('CLOSED shows last when the setting is on', () => {
    const sections = railSections(accounts, true);
    expect(sections.map((s) => s.key)).toEqual(['CASH:savings', 'CASH:checking', 'CASH:cash', 'CREDIT', 'CLOSED']);
    expect(sections[4]).toMatchObject({ label: 'Closed', accs: [{ id: 'old' }] });
  });

  test('no CLOSED section without closed accounts, even with the setting on', () => {
    expect(railSections([acc('chk', 'CASH', 'checking')], true).map((s) => s.key)).toEqual(['CASH:checking']);
  });

  test('a cash-group account of an unlabelled type gets its own section labelled Cash', () => {
    const sections = railSections([acc('odd', 'CASH', 'otherAsset'), acc('wallet', 'CASH', 'cash')], false);
    expect(sections.map((s) => [s.key, s.label])).toEqual([
      ['CASH:otherAsset', 'Cash'],
      ['CASH:cash', 'Cash'],
    ]);
  });

  test('no accounts, no sections; the input is not mutated', () => {
    expect(railSections([], true)).toEqual([]);
    const before = accounts.map((a) => a.id);
    railSections(accounts, true);
    expect(accounts.map((a) => a.id)).toEqual(before);
  });
});

describe('balances', () => {
  test('an account balance is cleared + uncleared in cents', () => {
    expect(railAccountBalance({ cleared_balance: 100000, uncleared_balance: -25000 })).toBe(7500);
    expect(railAccountBalance({ cleared_balance: -30000, uncleared_balance: 0 })).toBe(-3000);
  });

  test('a section total sums every account, and is 0 for none', () => {
    expect(
      railSectionTotal([
        { cleared_balance: 100000, uncleared_balance: -25000 },
        { cleared_balance: -200000, uncleared_balance: 10000 },
      ]),
    ).toBe(-11500);
    expect(railSectionTotal([])).toBe(0);
  });

  test('each side is converted to cents before summing (sub-cent milliunits round per side)', () => {
    // 5 milliunits = half a cent on each side: per-side rounding, not the rounded sum.
    const a = { cleared_balance: 5, uncleared_balance: 5 };
    expect(railAccountBalance(a)).toBe(Math.round(5 / 10) * 2);
    expect(railSectionTotal([a])).toBe(railAccountBalance(a));
  });
});

describe('fallbackBudgetId', () => {
  const budgets = [
    { id: 'archived', archived_at: '2026-01-01' },
    { id: 'b1', archived_at: null },
    { id: 'b2' },
  ];

  test('nothing to do while the list is empty or the active budget is listed', () => {
    expect(fallbackBudgetId(undefined, null)).toBeNull();
    expect(fallbackBudgetId([], 'gone')).toBeNull();
    expect(fallbackBudgetId(budgets, 'b2')).toBeNull();
    // An archived budget that is still listed stays active.
    expect(fallbackBudgetId(budgets, 'archived')).toBeNull();
  });

  test('no active budget, or a stale id: the first non-archived budget', () => {
    expect(fallbackBudgetId(budgets, null)).toBe('b1');
    expect(fallbackBudgetId(budgets, 'gone')).toBe('b1');
  });

  test('only archived budgets: the first one', () => {
    expect(fallbackBudgetId([{ id: 'a1', archived_at: 'x' }, { id: 'a2', archived_at: 'y' }], null)).toBe('a1');
  });
});
