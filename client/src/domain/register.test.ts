import { describe, expect, test } from 'bun:test';

import { moneyFormat } from './format';
import {
  filterRegisterTxns,
  futureInstallmentsTotal,
  installmentParts,
  registerCategoryCell,
  registerRunningBalances,
  scopeBalances,
  scopeRegisterTxns,
  splitScheduled,
} from './register';
import type { Account, Budget, Transaction } from './types';

const acct = (id: string, name: string): Account =>
  ({ id, name, type: 'checking', onBudget: true, clearedBalance: 0, unclearedBalance: 0 }) as unknown as Account;
const budget = {
  accounts: [acct('a1', 'Checking'), acct('a2', 'Savings')],
  categories: [{ id: 'c1', name: 'Mercado' }],
} as unknown as Pick<Budget, 'accounts' | 'categories'>;
const row = (over: Record<string, unknown>) =>
  ({ payee: 'Shop', categoryId: null, splits: undefined, inflow: 0, ...over }) as never;

describe('registerCategoryCell', () => {
  test('adjustments read Ready to Assign', () => {
    expect(registerCategoryCell(budget, row({ payee: 'Reconciliation Adjustment', categoryId: 'c1' }))).toEqual({ text: 'Ready to Assign', warn: false });
    expect(registerCategoryCell(budget, row({ payee: 'Balance Adjustment' }))).toEqual({ text: 'Ready to Assign', warn: false });
  });
  test('splits, inflows and uncategorized outflows', () => {
    expect(registerCategoryCell(budget, row({ splits: [{}, {}] }))).toEqual({ text: 'Split (2)', warn: false });
    expect(registerCategoryCell(budget, row({ inflow: 100 }))).toEqual({ text: 'Ready to Assign', warn: false });
    expect(registerCategoryCell(budget, row({}))).toEqual({ text: 'needs category', warn: true });
  });
  test('internal transfers read Transfer, unless the caller opts out (linked-account register)', () => {
    expect(registerCategoryCell(budget, row({ payee: 'Transfer : Savings' }))).toEqual({ text: 'Transfer', warn: false });
    expect(registerCategoryCell(budget, row({ payee: 'Transfer : Savings' }), { transfers: false })).toEqual({ text: 'needs category', warn: true });
  });
  test('categorized rows show the category name, ? when unknown', () => {
    expect(registerCategoryCell(budget, row({ categoryId: 'c1' }))).toEqual({ text: 'Mercado', warn: false });
    expect(registerCategoryCell(budget, row({ categoryId: 'zz' }))).toEqual({ text: '?', warn: false });
  });
});

// ---------------------------------------------------------------------------
// Register scope / filter / scheduled split (pinned from AccountsScreen).
// ---------------------------------------------------------------------------

const txn = (over: Partial<Transaction> & { id: string }): Transaction =>
  ({
    accountId: 'a1',
    date: '2026-03-10',
    payee: '',
    categoryId: null,
    memo: '',
    outflow: 0,
    inflow: 0,
    cleared: 'uncleared',
    approved: true,
    repeat: 'never',
    repeatRuleId: null,
    upcoming: false,
    ...over,
  }) as Transaction;

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
const parseMoney = moneyFormat().parseMoney;
const NO_FILTER = { showReconciled: true, showUnapprovedOnly: false, dateFrom: '', dateTo: '', searchQuery: '' };

describe('scopeRegisterTxns', () => {
  const accounts = [
    { id: 'a1', group: 'CASH' },
    { id: 'a2', group: 'CLOSED' },
  ] as unknown as Budget['accounts'];
  const transactions = [
    txn({ id: 't1', accountId: 'a1', date: '2026-03-01' }),
    txn({ id: 't2', accountId: 'a2', date: '2026-03-05' }),
    txn({ id: 't3', accountId: 'a1', date: '2026-03-09' }),
    txn({ id: 't4', accountId: 'a1', date: '2026-03-05' }),
    txn({ id: 't5', accountId: 'gone', date: '2026-03-02' }),
  ];
  const b = { accounts, transactions };

  test('All Accounts hides closed-account rows unless shown; newest first, ties keep input order', () => {
    expect(ids(scopeRegisterTxns(b, null, false))).toEqual(['t3', 't4', 't5', 't1']);
    expect(ids(scopeRegisterTxns(b, null, true))).toEqual(['t3', 't2', 't4', 't5', 't1']);
  });
  test('an explicit account shows its full register, closed or not', () => {
    expect(ids(scopeRegisterTxns(b, 'a2', false))).toEqual(['t2']);
    expect(ids(scopeRegisterTxns(b, 'a1', false))).toEqual(['t3', 't4', 't1']);
    expect(scopeRegisterTxns(b, 'nope', true)).toEqual([]);
  });
  test('does not mutate the budget rows', () => {
    scopeRegisterTxns(b, null, true);
    expect(ids(transactions)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });
});

describe('filterRegisterTxns', () => {
  const categories = [
    { id: 'c1', name: 'Mercado' },
    { id: 'c2', name: 'Rent' },
  ] as unknown as Budget['categories'];
  const rows = [
    txn({ id: 'r1', payee: 'Padaria', categoryId: 'c1', memo: 'pão', outflow: 1250, date: '2026-03-10' }),
    txn({ id: 'r2', payee: 'Landlord', categoryId: 'c2', memo: 'March', outflow: 200000, date: '2026-03-05', cleared: 'reconciled' }),
    txn({ id: 'r3', payee: 'Salary', inflow: 1250, date: '2026-03-01', approved: false, cleared: 'cleared' }),
    txn({ id: 'r4', payee: null as unknown as string, memo: null as unknown as string, outflow: 99, date: '2026-02-20' }),
  ];
  const run = (f: Partial<typeof NO_FILTER>) => ids(filterRegisterTxns(rows, { ...NO_FILTER, ...f }, categories, parseMoney));

  test('no filter returns the same array', () => {
    expect(filterRegisterTxns(rows, NO_FILTER, categories, parseMoney)).toBe(rows);
  });
  test('reconciled rows are hidden unless opted in', () => {
    expect(run({ showReconciled: false })).toEqual(['r1', 'r3', 'r4']);
  });
  test('unapproved-only view', () => {
    expect(run({ showUnapprovedOnly: true })).toEqual(['r3']);
  });
  test('date range is inclusive on both ends', () => {
    expect(run({ dateFrom: '2026-03-01' })).toEqual(['r1', 'r2', 'r3']);
    expect(run({ dateTo: '2026-03-05' })).toEqual(['r2', 'r3', 'r4']);
    expect(run({ dateFrom: '2026-03-05', dateTo: '2026-03-05' })).toEqual(['r2']);
  });
  test('search matches payee, category name and memo, case-insensitively, trimmed', () => {
    expect(run({ searchQuery: '  PADA ' })).toEqual(['r1']);
    expect(run({ searchQuery: 'rent' })).toEqual(['r2']);
    expect(run({ searchQuery: 'march' })).toEqual(['r2']);
    expect(run({ searchQuery: 'zzz' })).toEqual([]);
  });
  test('whitespace-only search is no search', () => {
    expect(run({ searchQuery: '   ' })).toEqual(['r1', 'r2', 'r3', 'r4']);
  });
  test('a query that parses as money also matches the exact inflow or outflow', () => {
    expect(run({ searchQuery: '12,50' })).toEqual(['r1', 'r3']);
    // 0 never matches by amount (rows with no inflow would all match).
    expect(run({ searchQuery: '0' })).toEqual([]);
  });
  test('filters compose', () => {
    expect(run({ showReconciled: false, searchQuery: '12,50', dateFrom: '2026-03-05' })).toEqual(['r1']);
  });
  test('the amount is parsed from the raw (untrimmed) query with the given parser', () => {
    const seen: string[] = [];
    filterRegisterTxns(rows, { ...NO_FILTER, searchQuery: ' 99 ' }, categories, (s) => {
      seen.push(s);
      return 99;
    });
    expect(seen).toEqual([' 99 ']);
  });
});

describe('splitScheduled', () => {
  test('future-dated rows go to Scheduled; today stays in the register', () => {
    const rows = [
      txn({ id: 'f', date: '2026-03-11' }),
      txn({ id: 'today', date: '2026-03-10' }),
      txn({ id: 'past', date: '2026-03-09' }),
    ];
    const { register, scheduled } = splitScheduled(rows, '2026-03-10');
    expect(ids(register)).toEqual(['today', 'past']);
    expect(ids(scheduled)).toEqual(['f']);
  });
  test('derived upcoming installments always go to Scheduled, even past-dated', () => {
    const inst = { number: 3, total: 12 };
    const rows = [
      txn({ id: 'i-future', date: '2026-04-05', upcoming: true, installment: inst }),
      txn({ id: 'i-past', date: '2026-03-05', upcoming: true, installment: inst }),
      txn({ id: 'real', date: '2026-03-05' }),
    ];
    const { register, scheduled } = splitScheduled(rows, '2026-03-10');
    expect(ids(register)).toEqual(['real']);
    expect(ids(scheduled)).toEqual(['i-future', 'i-past']);
  });
});

describe('futureInstallmentsTotal', () => {
  test('sums the derived installments only, as an amount owed', () => {
    const inst = { number: 2, total: 4 };
    expect(
      futureInstallmentsTotal([
        txn({ id: 'a', outflow: 1500, upcoming: true, installment: inst }),
        txn({ id: 'b', outflow: 1500, upcoming: true, installment: inst }),
        txn({ id: 'repeat', outflow: 9999, upcoming: true }),
        txn({ id: 'real', outflow: 777 }),
      ]),
    ).toBe(3000);
    expect(futureInstallmentsTotal([txn({ id: 'real', outflow: 777 })])).toBe(0);
  });
});

describe('registerRunningBalances', () => {
  const account = { clearedBalance: 1000, unclearedBalance: 500 } as unknown as Account;
  const rows = [
    txn({ id: 'future', date: '2026-03-20', outflow: 999 }),
    txn({ id: 'n', date: '2026-03-10', outflow: 300 }),
    txn({ id: 'o', date: '2026-03-01', inflow: 200 }),
  ];
  test('off, or no selected account: empty', () => {
    expect(registerRunningBalances(false, account, rows, '2026-03-10').size).toBe(0);
    expect(registerRunningBalances(true, undefined, rows, '2026-03-10').size).toBe(0);
  });
  test('the newest non-future row carries the working balance; future rows are skipped', () => {
    const map = registerRunningBalances(true, account, rows, '2026-03-10');
    expect(map.has('future')).toBe(false);
    expect(map.get('n')).toBe(1500);
    expect(map.get('o')).toBe(1800);
  });
  test('a past-dated derived installment never enters the running balance', () => {
    const map = registerRunningBalances(
      true,
      account,
      [...rows, txn({ id: 'inst', date: '2026-03-05', outflow: 50, upcoming: true, installment: { number: 2, total: 3 } })],
      '2026-03-10',
    );
    expect(map.has('inst')).toBe(false);
    expect(map.get('o')).toBe(1800);
  });
});

describe('scopeBalances', () => {
  test('sums cleared, uncleared and working over the accounts in scope', () => {
    const accts = [
      { clearedBalance: 100, unclearedBalance: -30 },
      { clearedBalance: 5, unclearedBalance: 7 },
    ] as unknown as Account[];
    expect(scopeBalances(accts)).toEqual({ cleared: 105, uncleared: -23, working: 82 });
    expect(scopeBalances([])).toEqual({ cleared: 0, uncleared: 0, working: 0 });
  });
});

describe('installmentParts', () => {
  test('splits the purchase name from the kk/NN fraction', () => {
    expect(installmentParts({ payee: 'ACADEMIA ACQUA 03/12', installment: { number: 3, total: 12 } })).toEqual({
      name: 'ACADEMIA ACQUA',
      fraction: '03/12',
    });
    expect(installmentParts({ payee: 'Gym (renamed)', installment: { number: 3, total: 12 } })).toEqual({
      name: 'Gym (renamed)',
      fraction: '03/12',
    });
  });
  test('null for a row that is not a derived installment', () => {
    expect(installmentParts({ payee: 'ACADEMIA ACQUA 03/12' })).toBeNull();
  });
});
