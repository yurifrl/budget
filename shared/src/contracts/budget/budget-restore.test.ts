import { describe, expect, test } from 'bun:test';

import { budgetRestore } from './budget-restore';

const base = {
  budget_id: crypto.randomUUID(),
  groups: [],
  categories: [],
  accounts: [],
  transactions: [],
  assignments: [],
};

describe('budget_restore sections', () => {
  test('sections is optional (default = everything), so existing callers stay valid', () => {
    expect(budgetRestore.input.safeParse(base).success).toBe(true);
  });
  test('accepts plan, register, or both', () => {
    for (const sections of [['plan'], ['register'], ['plan', 'register']]) {
      expect(budgetRestore.input.safeParse({ ...base, sections }).success).toBe(true);
    }
  });
  test('rejects empty, unknown and duplicated-beyond-two lists', () => {
    for (const sections of [[], ['all'], ['plan', 'register', 'plan']]) {
      expect(budgetRestore.input.safeParse({ ...base, sections }).success).toBe(false);
    }
  });
  test('output carries the optional uncategorized count', () => {
    const counts = { groups: 0, categories: 0, accounts: 0, transactions: 1, assignments: 0 };
    expect(budgetRestore.output!.safeParse(counts).success).toBe(true);
    expect(budgetRestore.output!.safeParse({ ...counts, uncategorized: 1 }).success).toBe(true);
  });
});
