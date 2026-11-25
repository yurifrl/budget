/**
 * Thin wiring shared by the shell and the page: the rail's "left to
 * categorize" count. The queue's counts cover the WHOLE queue, so one row is
 * enough for the badge.
 *
 * The badge never polls and does not refetch on focus/reconnect; it refreshes
 * only when the revision watcher (or a local write) invalidates the queue. When
 * a completed read says zero and the budget revision has not moved since, the
 * badge skips the subscription entirely and keeps showing 0 — there is no
 * smaller client-side "uncategorized" count in the budget list to gate on.
 */

import { skipToken } from '@reduxjs/toolkit/query';
import { useEffect, useState } from 'react';

import { budgetApi, useGetCategorizeQueueQuery } from '@/budget/data/api';
import { useAppSelector } from '@/state/hooks';
import { selectActiveBudgetId } from '@/state/ui';

type ZeroSync = { budgetId: string; revision: number };

export function useCategorizeLeft(): number | undefined {
  const budgetId = useAppSelector(selectActiveBudgetId);
  // Selector only: the shell's watcher owns the one revision poll.
  const revision = useAppSelector((s) =>
    budgetId ? budgetApi.endpoints.getBudgetRevision.select({ budgetId })(s).data?.revision : undefined,
  );
  const [knownZero, setKnownZero] = useState<ZeroSync | null>(null);

  const zeroStillFresh =
    budgetId != null && revision !== undefined && knownZero?.budgetId === budgetId && knownZero.revision === revision;
  const query = useGetCategorizeQueueQuery(zeroStillFresh || !budgetId ? skipToken : { budgetId, limit: 1 }, {
    refetchOnFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (!budgetId || revision === undefined || !query.data) return;
    setKnownZero(
      query.data.counts.left_to_categorize === 0 ? { budgetId, revision } : null,
    );
  }, [budgetId, revision, query.data]);

  if (zeroStillFresh) return 0;
  return query.data?.counts.left_to_categorize;
}
