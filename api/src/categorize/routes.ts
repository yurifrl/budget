/**
 * HTTP handlers of the Categorize page. Only parse/authorise/shape: every SQL
 * statement lives in queue-store.ts / decision-store.ts / store.ts, and every
 * route is mounted behind budgetAccess by ./router.ts.
 *
 * Any member may start a run and read the page; the run always uses the BUDGET
 * OWNER's key (store.runActorForBudget), so start checks that key up front and
 * answers a stable error code instead of enqueuing a run that would stop.
 */
import type { z } from '@shared/zod';

import {
  categorizeAccept,
  categorizeQueueList,
  categorizeRunStart,
  categorizeRunStatus,
  categorizeSettingsGet,
  categorizeSettingsSet,
  categorizeSkip,
  categorizeUndo,
  type categorizeAiStatusSchema,
} from '@shared/contracts/categorize';

import { aiKeyHttpError, resolveAiKey } from '../ai';
import type { CategorizeSkipProblem } from './messages';
import { implement } from '../core/operation';
import { pool } from '../core/db';
import { HttpError } from '../core/validate';
import type { JobRun } from '../jobs';
import { categorizeRunStatus as readRunStatus, startCategorizeRun } from './job';
import { acceptCategories, skipTransaction, undoAccept } from './decision-store';
import { getConfidenceThreshold, listQueue, setConfidenceThreshold } from './queue-store';
import { readRunProgress, runActorForBudget } from './store';

type AiStatus = z.output<typeof categorizeAiStatusSchema>;

/** A run's public shape: progress comes from the worker's row, 0/0 while queued. */
function activeJson(run: JobRun, progress: { done: number; total: number } | null) {
  return {
    id: run.id,
    status: run.status,
    created_at: run.created_at,
    started_at: run.started_at,
    requested_by: run.requested_by,
    done: progress?.done ?? 0,
    total: progress?.total ?? 0,
  };
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;

/** The last finished run: result counts when it has them, else the progress row. */
function finishedJson(run: JobRun, progress: { done: number; total: number } | null) {
  const result = (run.result ?? null) as Record<string, unknown> | null;
  return {
    id: run.id,
    status: run.status,
    created_at: run.created_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    total: count(result?.total) ?? progress?.total ?? null,
    done: count(result?.done) ?? progress?.done ?? null,
    suggested: count(result?.suggested),
    rule: count(result?.rule),
    empty: count(result?.empty),
    skipped: count(result?.skipped),
    failed: count(result?.failed),
    remaining: count(result?.remaining),
    user_message: run.user_message,
  };
}

/** Whether a run could start now, and the precise reason when it could not. */
async function aiStatus(budgetId: string): Promise<AiStatus> {
  const owner = await runActorForBudget(pool, budgetId);
  if (!owner) {
    return { available: false, reason: 'own_key_required', provider: null, model: null, source: null };
  }
  const resolved = await resolveAiKey(pool, owner);
  if (!resolved.ok) {
    return { available: false, reason: resolved.problem, provider: null, model: null, source: null };
  }
  if (!resolved.key.model) {
    return { available: false, reason: 'no_model', provider: resolved.key.provider, model: null, source: resolved.key.source };
  }
  return {
    available: true,
    reason: null,
    provider: resolved.key.provider,
    model: resolved.key.model,
    source: resolved.key.source,
  };
}

/**
 * The key problem as an HTTP error. `own_key_required` and `no_model` are the
 * budget-level "suggestions are off" state (the budget OWNER's key is the one
 * missing, which is not the caller's personal key problem); the rest keep the
 * AI-key codes the client already knows.
 */
function aiUnavailable(reason: CategorizeSkipProblem): HttpError {
  if (reason === 'own_key_required' || reason === 'no_model') {
    return new HttpError(409, 'category suggestions are unavailable for this budget', 'categorize_ai_unavailable');
  }
  return aiKeyHttpError(reason);
}

export const operations = [
  implement(categorizeQueueList, (_c, { budget_id: budgetId, limit, offset }) =>
    listQueue(pool, budgetId, { limit, offset }),
  ),

  implement(categorizeRunStart, async (_c, { budget_id: budgetId }) => {
    const status = await readRunStatus(pool, budgetId);
    if (status.active) {
      return { run: activeJson(status.active, await readRunProgress(pool, status.active.id)), created: false };
    }
    const owner = await runActorForBudget(pool, budgetId);
    if (!owner) throw new HttpError(404, 'budget not found');
    const resolved = await resolveAiKey(pool, owner);
    if (!resolved.ok) throw aiUnavailable(resolved.problem);
    if (!resolved.key.model) throw aiUnavailable('no_model');

    const user = _c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized');
    const started = await startCategorizeRun(pool, { budgetId, requestedBy: user.id });
    return {
      run: activeJson(started.run, await readRunProgress(pool, started.run.id)),
      created: started.created,
    };
  }),

  implement(categorizeRunStatus, async (_c, { budget_id: budgetId }) => {
    const { active, lastFinished } = await readRunStatus(pool, budgetId);
    return {
      active: active ? activeJson(active, await readRunProgress(pool, active.id)) : null,
      last_finished: lastFinished
        ? finishedJson(lastFinished, await readRunProgress(pool, lastFinished.id))
        : null,
      ai: await aiStatus(budgetId),
    };
  }),

  implement(categorizeAccept, (_c, { budget_id: budgetId, items }) => acceptCategories(pool, budgetId, items)),

  implement(categorizeUndo, (_c, { budget_id: budgetId, items }) => undoAccept(pool, budgetId, items)),

  implement(categorizeSkip, (_c, { budget_id: budgetId, transaction_id }) =>
    skipTransaction(pool, budgetId, transaction_id),
  ),

  implement(categorizeSettingsGet, async (_c, { budget_id: budgetId }) => ({
    budget_id: budgetId,
    confidence_threshold: await getConfidenceThreshold(pool, budgetId),
  })),

  implement(categorizeSettingsSet, async (_c, { budget_id: budgetId, confidence_threshold }) => ({
    budget_id: budgetId,
    confidence_threshold: await setConfidenceThreshold(pool, budgetId, confidence_threshold),
  })),
];
