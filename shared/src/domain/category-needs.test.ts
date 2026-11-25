import { describe, expect, test } from 'bun:test';

import { categoryNeed, isSystemAdjustmentPayee, needsCategory, type CategoryNeedInput } from './category-needs';

const base: CategoryNeedInput = {
  payee: 'Cafe',
  categoryId: null,
  splitCount: 0,
  amount: -2500,
  transferPending: null,
  transferPayee: false,
};

describe('categoryNeed', () => {
  test('an uncategorized outflow needs a category', () => {
    expect(categoryNeed(base)).toBe('needs_category');
    expect(needsCategory(base)).toBe(true);
  });

  test('adjustments and categorized rows never need one', () => {
    expect(categoryNeed({ ...base, payee: 'Reconciliation Adjustment' })).toBe('reconciliation');
    expect(categoryNeed({ ...base, payee: 'Balance Adjustment' })).toBe('reconciliation');
    expect(categoryNeed({ ...base, payee: '  Reconciliation Adjustment  ' })).toBe('needs_category');
    expect(categoryNeed({ ...base, categoryId: 'c-food' })).toBe('categorized');
    expect(isSystemAdjustmentPayee('Reconciliation Adjustment')).toBe(true);
    expect(isSystemAdjustmentPayee('Balance Adjustment')).toBe(true);
    expect(isSystemAdjustmentPayee('Cafe')).toBe(false);
    expect(isSystemAdjustmentPayee(null)).toBe(false);
  });

  test('a split parent shows Split, not Needs category', () => {
    expect(categoryNeed({ ...base, splitCount: 2 })).toBe('split');
    expect(needsCategory({ ...base, splitCount: 2 })).toBe(false);
  });

  test('transfer pending states and internal transfer payees need no category', () => {
    expect(categoryNeed({ ...base, transferPending: 'waiting' })).toBe('transfer_waiting');
    expect(categoryNeed({ ...base, transferPending: 'outside' })).toBe('transfer_outside');
    expect(categoryNeed({ ...base, transferPayee: true })).toBe('transfer');
    expect(needsCategory({ ...base, transferPayee: true })).toBe(false);
  });

  test('money in goes to Ready to Assign', () => {
    expect(categoryNeed({ ...base, amount: 100 })).toBe('inflow');
    // Zero is not inflow: a zero-amount row still needs its category.
    expect(categoryNeed({ ...base, amount: 0 })).toBe('needs_category');
  });

  test('the order matches the register cell', () => {
    // An adjustment payee wins over a category (the cell shows Ready to Assign).
    expect(categoryNeed({ ...base, payee: 'Reconciliation Adjustment', categoryId: 'c-food' })).toBe('reconciliation');
    // A categorized row wins over a split count.
    expect(categoryNeed({ ...base, categoryId: 'c-food', splitCount: 2 })).toBe('categorized');
    // A pending transfer is checked before the internal payee.
    expect(categoryNeed({ ...base, transferPending: 'waiting', transferPayee: true })).toBe('transfer_waiting');
  });
});
