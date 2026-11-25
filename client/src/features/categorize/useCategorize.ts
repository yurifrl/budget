/**
 * Thin wiring shared by the shell and the page. The queue response's counts
 * cover the WHOLE queue regardless of the requested page, so the rail badge
 * needs one row only.
 */

import { skipToken } from '@reduxjs/toolkit/query';

import { useGetCategorizeQueueQuery } from '@/budget/data/api';
import { useAppSelector } from '@/state/hooks';
import { selectActiveBudgetId } from '@/state/ui';

/** Transactions left to categorize; undefined until the first queue read lands. */
export function useCategorizeLeft(): number | undefined {
  const budgetId = useAppSelector(selectActiveBudgetId);
  const { data } = useGetCategorizeQueueQuery(budgetId ? { budgetId, limit: 1 } : skipToken);
  return data?.counts.left_to_categorize;
}
