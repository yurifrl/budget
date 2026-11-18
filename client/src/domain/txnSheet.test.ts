import { describe, expect, test } from 'bun:test';

import {
  canCreateNamed,
  canSaveAmount,
  initialSheetAmount,
  pickableAccounts,
  searchByLabel,
  sheetAccount,
  sheetEditPatch,
  sheetNewTransaction,
  type SheetForm,
} from './txnSheet';
import type { Transaction } from './types';

const txn = (over: Partial<Transaction>) => ({ inflow: 0, outflow: 0, ...over }) as Transaction;

describe('initialSheetAmount', () => {
  test('new entry starts at zero', () => {
    expect(initialSheetAmount(null)).toBe(0);
  });

  test('an edit takes the inflow when there is one, else the outflow', () => {
    expect(initialSheetAmount(txn({ outflow: 1250 }))).toBe(1250);
    expect(initialSheetAmount(txn({ inflow: 900 }))).toBe(900);
    expect(initialSheetAmount(txn({ inflow: 900, outflow: 1250 }))).toBe(900);
    expect(initialSheetAmount(txn({}))).toBe(0);
  });
});

describe('picker search', () => {
  const rows = [{ name: 'Padaria Real' }, { name: 'Uber' }, { name: 'uber eats' }];
  const name = (r: { name: string }) => r.name;

  test('blank search keeps everything', () => {
    expect(searchByLabel(rows, '  ', name)).toEqual(rows);
  });

  test('substring, case-insensitive, trimmed, on the given label', () => {
    expect(searchByLabel(rows, ' UBER ', name).map(name)).toEqual(['Uber', 'uber eats']);
    expect(searchByLabel(rows, 'bundle', (r) => `Bundle › ${r.name}`)).toHaveLength(3);
    expect(searchByLabel(rows, 'zzz', name)).toEqual([]);
  });

  test('create is offered only for a typed name nobody has exactly', () => {
    expect(canCreateNamed(rows, '')).toBe(false);
    expect(canCreateNamed(rows, '   ')).toBe(false);
    expect(canCreateNamed(rows, 'uber')).toBe(false);
    expect(canCreateNamed(rows, ' UBER EATS ')).toBe(false);
    expect(canCreateNamed(rows, 'Ube')).toBe(true);
    expect(canCreateNamed([], 'x')).toBe(true);
  });
});

describe('accounts', () => {
  const accounts = [
    { id: 'closed', closed: true },
    { id: 'a', closed: false },
    { id: 'b', closed: false },
  ];

  test('the picked account wins, even closed', () => {
    expect(sheetAccount(accounts, 'b')?.id).toBe('b');
    expect(sheetAccount(accounts, 'closed')?.id).toBe('closed');
  });

  test('no pick (or an unknown id) falls back to the first open account', () => {
    expect(sheetAccount(accounts, null)?.id).toBe('a');
    expect(sheetAccount(accounts, 'gone')?.id).toBe('a');
  });

  test('nothing loaded, or only closed accounts: no account', () => {
    expect(sheetAccount(undefined, null)).toBeUndefined();
    expect(sheetAccount([{ id: 'closed', closed: true }], null)).toBeUndefined();
  });

  test('the picker lists open accounts plus the picked closed one', () => {
    expect(pickableAccounts(accounts, null).map((a) => a.id)).toEqual(['a', 'b']);
    expect(pickableAccounts(accounts, 'closed').map((a) => a.id)).toEqual(['closed', 'a', 'b']);
  });
});

describe('save', () => {
  const form: SheetForm = { accountId: 'a', date: '2026-02-03', payee: '  Padaria ', categoryId: 'c1', isIncome: false, amount: 1234 };

  test('only a positive amount can be saved', () => {
    expect(canSaveAmount(1)).toBe(true);
    expect(canSaveAmount(0)).toBe(false);
    expect(canSaveAmount(-400)).toBe(false);
  });

  test('an edit patch: spending is an outflow, payee trimmed', () => {
    expect(sheetEditPatch(form)).toEqual({
      accountId: 'a',
      date: '2026-02-03',
      payee: 'Padaria',
      categoryId: 'c1',
      outflowCents: 1234,
      inflowCents: 0,
    });
  });

  test('income is an inflow', () => {
    expect(sheetEditPatch({ ...form, isIncome: true, categoryId: null })).toMatchObject({ outflowCents: 0, inflowCents: 1234, categoryId: null });
  });

  test('a new transaction is uncleared, approved, memo-less and never repeats', () => {
    expect(sheetNewTransaction(form)).toEqual({
      accountId: 'a',
      date: '2026-02-03',
      payee: 'Padaria',
      categoryId: 'c1',
      memo: '',
      outflowCents: 1234,
      inflowCents: 0,
      cleared: 'uncleared',
      approved: true,
      flag: null,
      repeat: 'never',
    });
    expect(sheetNewTransaction({ ...form, isIncome: true })).toMatchObject({ outflowCents: 0, inflowCents: 1234 });
  });
});
