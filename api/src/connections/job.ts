/**
 * The `connections_sync` job type, API side: registers it (the worker's relay
 * resolves the workflow from the registry) and wraps `enqueueJob`. Imported by
 * the connections barrel, so both the API and the worker register it.
 */
import { enqueueJob, registerJobType, type JobRun, type Queryable } from '../jobs';
import { CONNECTIONS_SYNC_JOB, syncSubjectKey, type ConnectionSyncInput, type SyncMode } from './jobspec';

registerJobType({ jobType: CONNECTIONS_SYNC_JOB, workflow: 'connectionsSync' });

/**
 * Enqueue (or join) a sync run for one connection. Pass a transaction client
 * to make it part of the caller's transaction (outbox).
 */
export async function enqueueConnectionSync(
  db: Queryable,
  conn: { id: string; user_id: string },
  mode: SyncMode,
  requestedBy: string,
): Promise<{ run: JobRun; created: boolean }> {
  return enqueueJob(db, {
    jobType: CONNECTIONS_SYNC_JOB,
    subjectKey: syncSubjectKey(conn.id, mode),
    tenantId: conn.user_id,
    input: { mode } satisfies ConnectionSyncInput,
    requestedBy,
  });
}
