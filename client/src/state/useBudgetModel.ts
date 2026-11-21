/**
 * useBudgetModel — the screens' single entry point to budget data.
 *
 * Injects the active `budget_id` from the `budgetUi` slice into every
 * budget-scoped query (screens never thread it) and assembles the results
 * into the engine's `Budget` aggregate via the mapping layer. Derived values
 * (RTA, available, funding state) come from the zero-sum engine, once per
 * viewed month (`useBudgetMonth`).
 */

import { skipToken } from '@reduxjs/toolkit/query';
import { useMemo } from 'react';

import { useAppSelector } from './hooks';
import { t } from './i18n';

import {
  targetsByCategoryFromRows,
  useGetAccountsQuery,
  useGetAssignmentsQuery,
  useGetBudgetsQuery,
  useGetBundlesQuery,
  useGetCategoriesQuery,
  useGetCategoryTargetsQuery,
  useGetGroupsQuery,
  useGetMonthNotesQuery,
  useGetPayeesQuery,
  useGetTransactionsQuery,
} from '@/budget/data/api';
import { assembleBudget } from '@/budget/data/mapping';
import type { Budget } from '@/domain/types';
import { selectActiveBudgetId, selectActiveMonth } from './ui';

export interface BudgetModel {
  /** The active budget id (null until restored/selected). */
  budgetId: string | null;
  /** All budgets, for the switcher. */
  budgets: { id: string; name: string }[] | undefined;
  /** The assembled aggregate; undefined while any source is still loading. */
  budget: Budget | undefined;
  isLoading: boolean;
  error: string | undefined;
}

export function useBudgetModel(): BudgetModel {
  const budgetId = useAppSelector((s) => selectActiveBudgetId(s));
  const currentMonth = useAppSelector((s) => selectActiveMonth(s));

  const scope = budgetId ? { budgetId } : skipToken;
  const budgets = useGetBudgetsQuery();
  const groups = useGetGroupsQuery(scope);
  const categories = useGetCategoriesQuery(scope);
  const bundles = useGetBundlesQuery(scope);
  const accounts = useGetAccountsQuery(scope);
  const payees = useGetPayeesQuery(scope);
  const transactions = useGetTransactionsQuery(scope);
  const assignments = useGetAssignmentsQuery(scope);
  const monthNotes = useGetMonthNotesQuery(scope);
  const categoryTargets = useGetCategoryTargetsQuery(scope);

  const budgetRow = budgets.data?.find((b) => b.id === budgetId);

  const budget: Budget | undefined = useMemo(() => {
    if (
      !budgetRow ||
      !groups.data ||
      !categories.data ||
      !bundles.data ||
      !accounts.data ||
      !payees.data ||
      !transactions.data ||
      !assignments.data ||
      !monthNotes.data ||
      !categoryTargets.data
    ) {
      return undefined;
    }
    const assembled = assembleBudget({
      budget: budgetRow,
      groups: groups.data,
      categories: categories.data,
      bundles: bundles.data,
      accounts: accounts.data,
      payees: payees.data,
      transactions: transactions.data,
      assignments: assignments.data,
      monthNotes: monthNotes.data,
      currentMonth,
    });
    // One source of truth for targets: a `category_targets` row wins over the
    // legacy YNAB goal_* mapping; either way `category.target` is the unified
    // `CategoryTarget` every consumer (engine, ball, editor, auto-assign) reads.
    const targets = targetsByCategoryFromRows(categoryTargets.data);
    return {
      ...assembled,
      categories: assembled.categories.map((c) => {
        const t = targets.get(c.id);
        return t ? { ...c, target: t } : c;
      }),
    };
  }, [
    budgetRow,
    groups.data,
    categories.data,
    bundles.data,
    accounts.data,
    payees.data,
    transactions.data,
    assignments.data,
    monthNotes.data,
    categoryTargets.data,
    currentMonth,
  ]);

  const sources = [budgets, groups, categories, bundles, accounts, payees, transactions, assignments, monthNotes, categoryTargets];
  const isLoading = sources.some((q) => q.isLoading);
  const firstError = sources.find((q) => q.error);
  const error = firstError
    ? ((firstError.error as { message?: string })?.message ?? t('budget.loadFailed'))
    : undefined;

  return { budgetId, budgets: budgets.data, budget, isLoading, error };
}
