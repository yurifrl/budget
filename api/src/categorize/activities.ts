/**
 * Categorize activities (Temporal side; deep-imported by server/worker.ts).
 * `trackedAttempt` comes from the jobs ledger activities and is injected so
 * this feature never imports jobs internals.
 *
 * A RunFailure is permanent: no key, a key Jev refuses mid-run, no categories.
 * Retrying it would only repeat the same answer, so it closes the run with its
 * own user-safe message.
 */
import { ApplicationFailure, Context } from '@temporalio/activity';
import type { Pool } from 'pg';

import type { JobContext } from '../jobs';

import { RunFailure, runCategorize } from './run';
import { markInternalFailure } from './run-store';
import type { RunProgress } from './run-store';

type Tracked = <T>(runId: string, body: (ctx: JobContext) => Promise<T>) => Promise<T>;

/** The current activity context, or null outside an activity (unit tests). */
function activityContext(): Context | null {
  try {
    return Context.current();
  } catch {
    return null;
  }
}

/** What the workflow proxies: the run itself, and the failure code a crash leaves behind. */
export interface CategorizeActivities {
  categorizeRunWork(args: { runId: string; budgetId: string; take?: number }): Promise<RunProgress>;
  /**
   * Persist "this run stopped for no named reason" after the activity's
   * retries are exhausted (a crash, a timeout, an OOM). Keeps a named code
   * already written by the run: only a null failure becomes `internal`.
   */
  markRunFailed(args: { runId: string; budgetId: string }): Promise<void>;
}

export function createCategorizeActivities(db: Pool, trackedAttempt: Tracked): CategorizeActivities {
  return {
    /** The whole run: candidates, one Jev call each, suggestions and progress. */
    async categorizeRunWork(args: { runId: string; budgetId: string; take?: number }): Promise<RunProgress> {
      return trackedAttempt(args.runId, async (ctx) => {
        try {
          return await runCategorize(db, args, {
            log: (level, message, fields) => ctx.log(level, message, fields),
            heartbeat: () => activityContext()?.heartbeat(),
          });
        } catch (err) {
          if (err instanceof RunFailure) {
            throw ApplicationFailure.create({ message: err.message, type: 'Permanent', nonRetryable: true });
          }
          throw err;
        }
      });
    },
    async markRunFailed(args: { runId: string; budgetId: string }): Promise<void> {
      await markInternalFailure(db, args.runId, args.budgetId);
    },
  };
}

