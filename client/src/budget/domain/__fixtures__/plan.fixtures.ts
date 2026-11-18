/** Hand-built categories and engine months for the plan*.test.ts files (test support only). */
import type { Budget, Category, CategoryGroup, MonthKey } from '../types';
import type { BudgetMonth, CategoryMonth } from '../zeroSum';

export const JUN: MonthKey = 202606;

export const cat = (id: string, groupId = 'g1', extra: Partial<Category> = {}): Category => ({
  id,
  groupId,
  name: id.toUpperCase(),
  assigned: {},
  activity: {},
  ...extra,
});

export const group = (id: string, name = id): CategoryGroup => ({ id, name, categoryIds: [] });

/** An engine month holding only the given spending-category figures. */
export const month = (categories: Record<string, Partial<CategoryMonth>> = {}, m: MonthKey = JUN): BudgetMonth => ({
  month: m,
  readyToAssign: 0,
  categories: Object.fromEntries(
    Object.entries(categories).map(([id, f]) => [
      id,
      { assigned: 0, activity: 0, carryover: 0, available: 0, cashOverspend: 0, creditOverspend: 0, ...f },
    ]),
  ),
  payments: {},
} as BudgetMonth);

export const budgetOf = (parts: Pick<Budget, 'groups' | 'categories'> & Partial<Budget>): Budget =>
  ({ bundles: [], accounts: [], transactions: [], payees: [], ...parts }) as Budget;
