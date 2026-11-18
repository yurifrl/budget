/**
 * Keeps the budget's cached data fresh against writes this client did not make
 * (sync worker, webhooks, CLI/MCP, other devices, household members). Polls the
 * server's per-budget revision every REVISION_POLL_MS while the app is focused
 * (RTK pauses polling when focus is lost, see core/state/listeners) and
 * invalidates every budget-scoped tag when it changes. Mount once, at the shell.
 *
 * Our own mutations also bump the revision, so each local write costs one
 * redundant refetch on the next poll; accepted for simplicity.
 */

import { useEffect, useRef } from 'react';

import { useAppDispatch } from '@/store/hooks';

import { budgetApi, useGetBudgetRevisionQuery } from '../data/api';
import { BUDGET_DATA_TAGS, REVISION_POLL_MS, decideRevision } from '../domain/revision';

export function useBudgetRevisionWatcher(budgetId: string | null | undefined): void {
  const dispatch = useAppDispatch();
  const { data } = useGetBudgetRevisionQuery(
    { budgetId: budgetId ?? '' },
    { skip: !budgetId, pollingInterval: REVISION_POLL_MS, skipPollingIfUnfocused: true },
  );
  const seen = useRef<{ budgetId: string | null | undefined; revision: number | null }>({ budgetId, revision: null });

  useEffect(() => {
    if (!budgetId || !data) return;
    if (seen.current.budgetId !== budgetId) seen.current = { budgetId, revision: null };
    const { last, invalidate } = decideRevision(seen.current.revision, data.revision);
    seen.current.revision = last;
    if (invalidate) {
      dispatch(
        budgetApi.util.invalidateTags([
          ...BUDGET_DATA_TAGS.map((type) => ({ type, id: budgetId })),
          'Connections' as const,
        ]),
      );
    }
  }, [budgetId, data, dispatch]);
}
