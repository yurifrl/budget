/**
 * Request a background bank sync/re-import and wait for its outcome: enqueue,
 * poll the sync-status endpoint until the run is terminal (or the scheduler is
 * offline), refresh the budget data the sync touched, and return the text the
 * screen should show. Shared by the linked-banks list, the per-bank page and
 * the account editor.
 */

import { useCallback } from 'react';

import { useAppDispatch } from '@/store/hooks';

import { budgetApi, useLazyGetSyncStatusQuery, useReimportHistoryMutation, useSyncConnectionMutation } from '../../data/api';
import { awaitSyncRun, describeSyncOutcome } from '../../model/banks/syncRun';

export type SyncMode = 'sync' | 'reimport';

export function useSyncRunner(budgetId: string | null | undefined) {
  const dispatch = useAppDispatch();
  const [fetchStatus] = useLazyGetSyncStatusQuery();
  const [requestSync, syncState] = useSyncConnectionMutation();
  const [requestReimport, reimportState] = useReimportHistoryMutation();

  const run = useCallback(
    async (connectionId: string, mode: SyncMode) => {
      const request = mode === 'sync' ? requestSync : requestReimport;
      const { run: queued } = await request({ id: connectionId, budgetId: budgetId ?? '' }).unwrap();
      const outcome = await awaitSyncRun(() => fetchStatus(undefined, false).unwrap(), connectionId, queued.id);
      if (outcome.kind === 'done' && outcome.run?.status === 'succeeded' && budgetId) {
        // The job wrote accounts/transactions/payees server-side: refresh what it touched.
        dispatch(
          budgetApi.util.invalidateTags([
            'Connections',
            { type: 'Accounts', id: budgetId },
            { type: 'Transactions', id: budgetId },
            { type: 'Payees', id: budgetId },
          ]),
        );
      }
      return describeSyncOutcome(outcome, mode === 'sync' ? 'Sync' : 'Re-import');
    },
    [budgetId, dispatch, fetchStatus, requestReimport, requestSync],
  );

  /** True while a request is being enqueued (the wait itself is the caller's own busy state). */
  return { run, requesting: syncState.isLoading || reimportState.isLoading };
}
