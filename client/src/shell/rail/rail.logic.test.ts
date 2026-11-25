import { describe, expect, test } from 'bun:test';

import type { AccountRow } from '@/budget/data/rows';
import { railAccountBalance, railSections, railSectionTotal, shellGate, showsTransactionFab } from './rail.logic';

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

describe('shellGate', () => {
  const budgets = [{ id: 'archived' }, { id: 'b1' }];
  const gate = (over: Partial<Parameters<typeof shellGate>[0]>) =>
    shellGate({ restored: true, activeId: 'b1', budgets, isFetching: false, isError: false, ...over });

  test('waits for the persisted id before deciding anything', () => {
    expect(gate({ restored: false })).toBe('loading');
    expect(gate({ restored: false, activeId: null, budgets: [] })).toBe('loading');
  });

  test('a listed active budget renders the shell, archived or not, also while refetching', () => {
    expect(gate({})).toBe('ready');
    expect(gate({ activeId: 'archived' })).toBe('ready');
    expect(gate({ isFetching: true })).toBe('ready');
  });

  test('no active budget goes home and never picks one', () => {
    expect(gate({ activeId: null })).toBe('home');
    expect(gate({ activeId: null, budgets: undefined, isFetching: true })).toBe('home');
  });

  test('zero budgets goes home instead of spinning', () => {
    expect(gate({ activeId: 'gone', budgets: [] })).toBe('home');
    expect(gate({ activeId: null, budgets: [] })).toBe('home');
  });

  test('a stale id goes home once the list has settled', () => {
    expect(gate({ activeId: 'gone' })).toBe('home');
  });

  test('an id missing from a list still loading or refetching waits (budget-fwf)', () => {
    expect(gate({ activeId: 'new', isFetching: true })).toBe('loading');
    expect(gate({ activeId: 'b1', budgets: undefined, isFetching: true })).toBe('loading');
    expect(gate({ activeId: 'b1', budgets: undefined })).toBe('loading');
  });

  test('a failed list goes home, where the error and a retry are shown', () => {
    expect(gate({ activeId: 'b1', budgets: undefined, isError: true })).toBe('home');
  });
});

describe('showsTransactionFab', () => {
  test('budget pages keep the FAB', () => {
    for (const p of ['/overview', '/plan', '/spending', '/accounts', '/reflect', '/payees']) {
      expect(showsTransactionFab(p)).toBe(true);
    }
  });

  test('bank setup pages, the AI key page and the transaction page hide it (it covered "Connect another bank")', () => {
    for (const p of ['/connect-bank', '/connection', '/pluggy-keys', '/pluggy-keys/', '/pluggy-keys?reason=connect', '/ai-keys', '/transaction?id=x']) {
      expect(showsTransactionFab(p)).toBe(false);
    }
  });

  test('only exact routes match, not prefixes', () => {
    expect(showsTransactionFab('/connection-history')).toBe(true);
  });
});
