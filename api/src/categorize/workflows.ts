/**
 * Categorize workflow (runs in the Temporal sandbox: ONLY @temporalio/workflow,
 * type-only imports and pure files — no pg, no Bun). Re-exported from
 * server/jobs/workflows/index.ts, the single bundle the worker loads.
 *
 * One run per budget at a time: the budget is the run's subject key, so the
 * ledger refuses a second active run. A worker restart resumes the activity
 * (its writes are idempotent and progress is per row); a RunFailure is a
 * non-retryable ApplicationFailure and closes the run with its own message.
 */
import { proxyActivities } from '@temporalio/workflow';

import type { CategorizeActivities } from './activities';
import { runTracked, type JobArgs } from '../jobs/workflows/tracked';

const work = proxyActivities<CategorizeActivities>({
  // A run asks about the rows the person chose, 4 at a time with up to 15 s per
  // call, so its time grows with the run: the row count the hour allows (5000)
  // takes ~5 hours in the worst case. The heartbeat (sent before every call) is
  // what detects a dead worker; this is only the upper bound on a live one, so
  // it clears the worst case. A cut-off or crashed delivery is retried and
  // resumes within the run's frozen total (progress row + rows already touched).
  startToCloseTimeout: '6 hours',
  heartbeatTimeout: '1 minute',
  retry: { maximumAttempts: 3, initialInterval: '10 seconds', backoffCoefficient: 2 },
});

export async function categorizeRun(args: JobArgs): Promise<unknown> {
  const { budgetId, take } = (args.input ?? {}) as { budgetId?: string; take?: number };
  const subject = budgetId ?? args.subjectKey;
  return runTracked(args, async () => {
    try {
      return await work.categorizeRunWork({ runId: args.runId, budgetId: subject, take });
    } catch (err) {
      // A run that used up its retries still has to say WHY on the page; a
      // named code the run itself wrote is kept.
      await work.markRunFailed({ runId: args.runId, budgetId: subject });
      throw err;
    }
  });
}
