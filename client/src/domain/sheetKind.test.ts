import { describe, expect, test } from 'bun:test';

import { initialSheetKind, resolveSheetCategory, toggleSheetKind } from './sheetKind';
import type { Transaction } from './types';

const base: Transaction = {
  id: 't-1',
  accountId: 'acc-1',
  date: '2026-10-04',
  payee: 'Mercado',
  categoryId: null,
  memo: '',
  outflow: 0,
  inflow: 0,
  cleared: 'uncleared',
  approved: true,
  repeat: 'never',
  repeatRuleId: null,
  upcoming: false,
};
const edit = (p: Partial<Transaction>): Transaction => ({ ...base, ...p });

describe('sheet kind resolution', () => {
  test('categorized inflow edit keeps its category', () => {
    const s = initialSheetKind(edit({ inflow: 5000, categoryId: 'groceries' }), null);
    expect(s.isIncome).toBe(true);
    expect(resolveSheetCategory(s, true)).toBe('groceries');
  });

  test('uncategorized inflow edit stays Ready to Assign', () => {
    const s = initialSheetKind(edit({ inflow: 5000 }), null);
    expect(s.isIncome).toBe(true);
    expect(resolveSheetCategory(s, true)).toBeNull();
  });

  test('outflow edit is unchanged', () => {
    const s = initialSheetKind(edit({ outflow: 900, categoryId: 'groceries' }), null);
    expect(s.isIncome).toBe(false);
    expect(resolveSheetCategory(s, true)).toBe('groceries');
  });

  test('toggling an expense to income clears the category', () => {
    const s = toggleSheetKind(initialSheetKind(edit({ outflow: 900, categoryId: 'groceries' }), null));
    expect(s.isIncome).toBe(true);
    expect(resolveSheetCategory(s, true)).toBeNull();
  });

  test('toggling a categorized inflow to spending then back clears it', () => {
    const s0 = initialSheetKind(edit({ inflow: 5000, categoryId: 'groceries' }), null);
    const spending = toggleSheetKind(s0);
    expect(spending.isIncome).toBe(false);
    expect(resolveSheetCategory(spending, true)).toBe('groceries');
    expect(resolveSheetCategory(toggleSheetKind(spending), true)).toBeNull();
  });

  test('picking a category on an edited inflow is kept', () => {
    const s = { ...initialSheetKind(edit({ inflow: 5000 }), null), categoryId: 'rent' };
    expect(resolveSheetCategory(s, true)).toBe('rent');
  });

  test('new transaction: spending uses prefill, income is always Ready to Assign', () => {
    const s = initialSheetKind(null, 'cat-9');
    expect(s).toEqual({ isIncome: false, categoryId: 'cat-9' });
    expect(resolveSheetCategory(s, false)).toBe('cat-9');
    const inc = { isIncome: true, categoryId: 'cat-9' };
    expect(resolveSheetCategory(inc, false)).toBeNull();
  });
});
