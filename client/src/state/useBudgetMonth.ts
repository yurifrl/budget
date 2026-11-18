/**
 * useBudgetMonth — the zero-sum engine's figures for the viewed month, computed
 * once per (budget, month) (domain `budgetMonth` cache) and handed to every row.
 * Screens never call the engine per row. Before the budget loads this returns
 * an all-zero month so callers need no null branches.
 */

import { useMemo } from 'react';

import { budgetMonth, type BudgetMonth } from '@/domain/zeroSum';
import type { Budget, MonthKey } from '@/domain/types';

const emptyMonth = (month: MonthKey): BudgetMonth => ({ month, readyToAssign: 0, categories: {}, payments: {} });

export function useBudgetMonth(budget: Budget | undefined, month: MonthKey): BudgetMonth {
  return useMemo(() => (budget ? budgetMonth(budget, month) : emptyMonth(month)), [budget, month]);
}
