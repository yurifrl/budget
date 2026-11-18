import type { AppDispatch } from '@/state/hooks';

import { budgetApi } from '@/budget/data/api';
import type { BudgetRow } from '@/budget/data/rows';

/**
 * Force-refetch the Budgets list and resolve the fresh rows. Same rule
 * FreshStartPane applies: switching while the invalidation refetch is still
 * in flight lets the shell's stale-list reconcile bounce the active id back
 * to data[0] — which a fresh archive just made an archived budget.
 */
export async function refetchBudgets(dispatch: AppDispatch): Promise<BudgetRow[]> {
  return dispatch(
    budgetApi.endpoints.getBudgets.initiate(undefined, { forceRefetch: true }),
  ).unwrap();
}
