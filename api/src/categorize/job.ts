/**
 * The `categorize_run` job type, API side: registers it (the worker's relay
 * resolves the workflow from the registry) and wraps `enqueueJob`. Imported by
 * the categorize barrel, so both the API and the worker register it.
 */
import { enqueueJob, registerJobType, type JobRun, type Queryable } from '../jobs';

export const CATEGORIZE_RUN_JOB = 'categorize_run';

registerJobType({ jobType: CATEGORIZE_RUN_JOB, workflow: 'categorizeRun' });

/** One run per budget at a time: the budget IS the subject. */
export const runSubjectKey = (budgetId: string): string => budgetId;

/** Queue a run. A run already active for the budget is returned, not duplicated. */
export function enqueueCategorizeRun(
  db: Queryable,
  budgetId: string,
  requestedBy: string,
): Promise<{ run: JobRun; created: boolean }> {
  return enqueueJob(db, {
    jobType: CATEGORIZE_RUN_JOB,
    subjectKey: runSubjectKey(budgetId),
    input: { budgetId },
    requestedBy,
  });
}
