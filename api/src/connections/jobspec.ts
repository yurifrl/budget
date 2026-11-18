/**
 * Pure constants + key helpers of the `connections_sync` job. No imports, so
 * the Temporal workflow bundle (workflows.ts) can use them.
 *
 * Coalescing: the ledger's partial unique index is on (job_type, subject_key)
 * for queued/running runs, so concurrent triggers (manual, webhook, sweep)
 * for one connection join the same run. A reimport uses the distinct subject
 * key `<connectionId>:reimport` so it is NOT swallowed by an in-flight sync;
 * its workflow then waits for the plain sync to finish before running
 * (see workflows.ts), giving "queued after".
 */
export const CONNECTIONS_SYNC_JOB = 'connections_sync';
export const CONNECTIONS_SWEEP_SCHEDULE_ID = 'connections-sweep';
/** Every 6 hours — the safety net behind webhooks. */
export const CONNECTIONS_SWEEP_CRON = '0 */6 * * *';
/** Suffix appended to the task queue for Pluggy-calling activities (rate limited). */
export const PLUGGY_QUEUE_SUFFIX = '-pluggy';
/** ~60 provider-bound activity starts per minute across all worker pods. */
export const PLUGGY_ACTIVITIES_PER_SECOND = 1;

export type SyncMode = 'sync' | 'reimport';
export interface ConnectionSyncInput {
  mode: SyncMode;
}

export const syncSubjectKey = (connectionId: string, mode: SyncMode): string =>
  mode === 'reimport' ? `${connectionId}:reimport` : connectionId;

/** Inverse of syncSubjectKey. */
export const connectionIdFromSubject = (subjectKey: string): string => subjectKey.split(':')[0]!;
