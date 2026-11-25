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
import { HttpError } from '../core/validate';
import { CATEGORIZE_RUN_JOB } from './jobspec';
import { runActorForBudget } from './store';

registerJobType({ jobType: CATEGORIZE_RUN_JOB, workflow: 'categorizeRun' });

export type StartCategorizeRunParams = {
  budgetId: string;
  /** The signed-in person asking for the run (audit only; not who pays). */
  requestedBy: string;
  /** Explicit re-classify: also re-ask transactions that already have suggestions. */
  force?: boolean;
};

/**
 * Enqueue (or join) a categorization run for one budget. The caller does NOT
 * choose who the run acts for: `runActorForBudget` derives it (today the
 * budget owner, whose key pays) and the ledger tenant is that same person.
 * Pass a transaction client to make the enqueue part of the caller's
 * transaction (outbox).
 *
 * RE-RUN RULE (also in docs/decisions.md): once a person accepted or dismissed
 * any suggestion for a transaction, that transaction is FROZEN for good. A
 * normal run skips it because it has suggestion rows; an explicit re-classify
 * (`force`) skips it too (`hasDecidedSuggestion`), and `replaceSuggestions`
 * refuses every write for it. This holds when the accepted category is later
 * cleared, when every suggestion was dismissed, and when the only pending
 * suggestion points at a since-hidden category. A future "unfreeze" is a
 * product change, not a flag on this call. An attempt that ended with no
 * suggestion or a failure is NOT a decision: it can be retried (failed, after
 * a backoff) or re-asked by `force`, and a payee/memo change re-asks a
 * no_suggestion row.
 */
export async function startCategorizeRun(
  db: Queryable,
  params: StartCategorizeRunParams,
): Promise<{ run: JobRun; created: boolean }> {
  const actor = await runActorForBudget(db, params.budgetId);
  if (!actor) throw new HttpError(404, 'budget not found');
  return enqueueJob(db, {
    jobType: CATEGORIZE_RUN_JOB,
    subjectKey: params.budgetId,
    tenantId: actor,
    input: { force: params.force === true },
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
