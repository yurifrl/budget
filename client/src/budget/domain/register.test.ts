import { describe, expect, test } from 'bun:test';

import { registerCategoryCell } from './register';
import type { Account, Budget } from './types';

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
