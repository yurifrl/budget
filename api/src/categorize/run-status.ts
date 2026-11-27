/**
 * The Categorize run as the page polls it: whether a Jev key is available for
 * this budget, and the state of the run in flight (or the latest one). Reads the
 * jobs ledger and the run's own progress row; no SQL of its own, and never the
 * key itself.
 */
import type { CategorizeRunStatus } from '@shared/contracts/categorize';

import { CATEGORIZE_HOURLY_LIMIT } from '@shared/contracts/categorize';

import type { Queryable } from '../core/db';
import { runsForSubjects } from '../jobs';
import { resolveJevKey } from '../jev';
import { CATEGORIZE_RUN_JOB, runSubjectKey } from './job';
import { budgetOwnerId, candidateWaiting, hourlyUse, readProgress } from './run-store';
import { MAX_ATTEMPTS_PER_TRANSACTION } from './run';
import { matcherRowIds } from './store';

/**
 * Resolution uses the budget OWNER's key, exactly like the run itself (the two
 * must agree, or the page would offer a Run the run then refuses). A budget
 * with no owner has no key holder at all, which the page explains.
 */
export async function runStatus(db: Queryable, budgetId: string): Promise<CategorizeRunStatus> {
  const owner = await budgetOwnerId(db, budgetId);
  const access = owner ? await resolveJevKey(db, owner) : ({ ok: false, problem: 'no_owner' } as const);
  const { active, lastFinished } = await runsForSubjects(db, CATEGORIZE_RUN_JOB, [runSubjectKey(budgetId)]);
  const run = active[0] ?? lastFinished[0] ?? null;
  const progress = run ? await readProgress(db, run.id) : null;
  // What is waiting right now, by the run's own rule and the run's own excluded
  // rows (not the queue's size, which also holds rows that already carry
  // suggestions): the count the page shows is the count a run sends.
  const waiting = await candidateWaiting(
    db,
    budgetId,
    await matcherRowIds(db, budgetId),
    MAX_ATTEMPTS_PER_TRANSACTION,
  );
  const hourly = await hourlyUse(db, budgetId);
  return {
    budget_id: budgetId,
    configured: access.ok,
    waiting,
    // A run has no size of its own: everything waiting, trimmed by the hour.
    candidates: Math.max(0, Math.min(waiting, CATEGORIZE_HOURLY_LIMIT - hourly.used)),
    reason: access.ok ? null : access.problem,
    hourly: { limit: CATEGORIZE_HOURLY_LIMIT, used: hourly.used, frees_in_minutes: hourly.freesInMinutes },
    run: run
      ? {
          run_id: run.id,
          state: run.status,
          total: progress?.total ?? 0,
          done: progress?.done ?? 0,
          failures: progress?.failures ?? 0,
          failure: progress?.failure ?? null,
          started_at: run.started_at ?? run.created_at,
        }
      : null,
  };
}
