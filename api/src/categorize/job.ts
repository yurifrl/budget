/**
 * The `categorize_run` job type, API side: registers it (the worker's relay
 * resolves the workflow from the registry) and owns the start/status reads the
 * queue task uses. Imported by the categorize barrel, so both the API process
 * and the worker register it.
 *
 * One run per budget: the subject key is the budget id, so concurrent triggers
 * join the same queued/running run (jobs ledger partial unique index).
 */
import { enqueueJob, registerJobType, runsForSubjects, type JobRun, type Queryable } from '../jobs';
import { CATEGORIZE_RUN_JOB } from './jobspec';

registerJobType({ jobType: CATEGORIZE_RUN_JOB, workflow: 'categorizeRun' });

/**
 * Enqueue (or join) a categorization run for one budget. `ownerUserId` is the
 * budget owner, whose AI key the run resolves (own first, else the shared key
 * when the feature is on for them). Pass a transaction client to make the
 * enqueue part of the caller's transaction (outbox).
 */
export async function startCategorizeRun(
  db: Queryable,
  params: { budgetId: string; ownerUserId: string; requestedBy: string },
): Promise<{ run: JobRun; created: boolean }> {
  return enqueueJob(db, {
    jobType: CATEGORIZE_RUN_JOB,
    subjectKey: params.budgetId,
    tenantId: params.ownerUserId,
    input: {},
    requestedBy: params.requestedBy,
  });
}

/** The budget's current run (queued/running) and its last finished run, if any. */
export async function categorizeRunStatus(
  db: Queryable,
  budgetId: string,
): Promise<{ active: JobRun | null; lastFinished: JobRun | null }> {
  const { active, lastFinished } = await runsForSubjects(db, CATEGORIZE_RUN_JOB, [budgetId]);
  return { active: active[0] ?? null, lastFinished: lastFinished[0] ?? null };
}
