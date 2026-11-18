/**
 * Live sync status for the bank screens: polls GET /connections/sync-status
 * (fast while a run is active, slow otherwise) and exposes the per-connection
 * entry plus the scheduler-offline banner text.
 */

import { useEffect, useState } from 'react';

import { useGetSyncStatusQuery } from '@/budget/data/api';
import type { ConnectionSyncStatusJson } from '@/budget/data/connections';
import { hasActiveRun, schedulerBanner } from '../model/syncRun';

const FAST_MS = 3_000;
const SLOW_MS = 15_000;

export function useSyncStatus() {
  const [pollMs, setPollMs] = useState(SLOW_MS);
  const query = useGetSyncStatusQuery(undefined, { pollingInterval: pollMs });
  useEffect(() => setPollMs(hasActiveRun(query.data) ? FAST_MS : SLOW_MS), [query.data]);
  return {
    banner: schedulerBanner(query.data),
    entry: (id: string): ConnectionSyncStatusJson | null => query.data?.connections.find((c) => c.id === id) ?? null,
  };
}
