/**
 * One chunk of a categorize run: pick the next window of transactions of ONE
 * budget, answer the existing payee rule first, send only the rest to the
 * model, and write the suggestions. Runs inside a Temporal activity
 * (./activities.ts); the workflow only sees counts, ids and a cursor.
 *
 * Failure policy is here, by CategorizeError kind (see ./errors.ts):
 *  - timeout      retried once for that transaction, then counted failed and
 *                 the chunk continues (a timed-out generation may be billed).
 *  - bad_response counted failed, chunk continues.
 *  - truncated    the provider cut the answer off at the output cap: counted
 *                 failed (recorded, so it is not re-billed blindly).
 *  - request      the provider refused THIS request (400/413/422): counted
 *                 failed, chunk continues — but three IN A ROW stop the run
 *                 with the user-safe systematic failure.
 * Every classification attempt is recorded in public.categorize_attempts, so
 * a no_suggestion row or a failed row is not re-billed by the next run.
 *  - budget       the transaction spent its token cap: counted failed.
 *  - rate_limited waited out once for the transaction (up to
 *                 IN_CHUNK_RATE_LIMIT_WAIT_MS, provider delay otherwise), then
 *                 thrown → the activity is retried by Temporal with the
 *                 provider's retry-after.
 *  - auth, permanent (account-level), transient → thrown → activity retry /
 *                 non-retryable stop of the run.
 * One failing transaction never fails the chunk.
 */
import { CancelledFailure } from '@temporalio/common';
import type { Pool } from 'pg';

import { providerFor, resolveAiKey, type AiTokenUsage } from '../ai';
import { suggestedCategoryForPayee } from '../budget';
import type { Queryable } from '../core/db';
import { classifyTransaction, type ClassifyRequest, type ClassifyResult } from './agent';
import { CategorizeError } from './errors';
import {
  CATEGORIZE_MAX_CONSECUTIVE_REQUEST_FAILURES,
  CATEGORIZE_RUN_LIMIT,
  DEFAULT_RATE_LIMIT_DELAY_MS,
  IN_CHUNK_RATE_LIMIT_WAIT_MS,
} from './jobspec';
import { withKeyLock } from './key-lock';
import type { CategorizeSkipProblem } from './messages';
import * as store from './store';
import { createTools } from './tools';

export type PrepareOutcome =
  | { total: number; remaining: number; snapshot: store.CandidateCursor | null }
  | { problem: CategorizeSkipProblem };
/** What prepare reports for a budget that no longer exists (the activity fails the run). */
export type PrepareResult = PrepareOutcome | { problem: 'budget_missing' };

/** Heartbeat payload of a chunk; also the resume state a retried attempt starts from. */
export type ChunkProgress = {
  /** Candidates this chunk examined, including a previous attempt's share. */
  examined: number;
  /** Run total from prepare (already capped). */
  total: number;
  /** Last processed candidate, for the keyset and for resuming. */
  cursor: store.CandidateCursor | null;
  suggested: number;
  rule: number;
  empty: number;
  skipped: number;
  failed: number;
  failedIds: string[];
  inputTokens: number;
  outputTokens: number;
};

export type ChunkOutcome =
  | { problem: CategorizeSkipProblem }
  | {
      examined: number;
      nextCursor: store.CandidateCursor | null;
      suggested: number;
      rule: number;
      empty: number;
      skipped: number;
      failed: number;
      /** Ids only (allowed in the activity result): what failed, never any provider text. */
      failedIds: string[];
      usage: AiTokenUsage;
    };

/** What a chunk reports for a budget that no longer exists (the activity fails the run). */
export type ChunkResult = ChunkOutcome | { problem: 'budget_missing' };

export type ChunkParams = {
  budgetId: string;
  /** Snapshot bound captured at prepare: rows newer than this are another run's. */
  snapshot: store.CandidateCursor;
  /** Where this chunk starts (the run's cursor); a resume overrides it. */
  cursor: store.CandidateCursor | null;
  limit: number;
  /** Re-classify transactions that already have suggestions. */
  force: boolean;
  /** Run total from prepare, for the heartbeat's done/total. */
  total: number;
  /** Resume state from a previous attempt's heartbeat, if any. */
  resume?: ChunkProgress;
  signal?: AbortSignal;
  /** Mirrors progress after every transaction and every billed call. */
  onProgress?: (progress: ChunkProgress) => void;
};

const emptyProgress = (total: number, cursor: store.CandidateCursor | null): ChunkProgress => ({
  examined: 0,
  total,
  cursor,
  suggested: 0,
  rule: 0,
  empty: 0,
  skipped: 0,
  failed: 0,
  failedIds: [],
  inputTokens: 0,
  outputTokens: 0,
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the run's actor and key (no provider call) and count what a run
 * would classify. `limit` is CATEGORIZE_RUN_LIMIT in production; tests use a
 * small value to exercise the cap without a hundred fixtures.
 */
export async function prepareRun(
  db: Queryable,
  budgetId: string,
  force: boolean,
  limit: number = CATEGORIZE_RUN_LIMIT,
): Promise<PrepareResult> {
  const owner = await store.runActorForBudget(db, budgetId);
  if (!owner) return { problem: 'budget_missing' };
  const resolved = await resolveAiKey(db, owner);
  if (!resolved.ok) return { problem: resolved.problem };
  if (!resolved.key.model) return { problem: 'no_model' };
  const window = await store.candidateWindow(db, budgetId, force);
  const total = Math.min(window.count, limit);
  return { total, remaining: window.count - total, snapshot: total > 0 ? window.newest : null };
}

/**
 * Classify one transaction, retrying a timeout at most once. Returns a
 * per-transaction failure for timeout/bad_response/request/budget; rethrows
 * auth/permanent/rate_limited/transient for the chunk's run-level policy.
 * Every attempt's usage is added through `addUsage` (which returns the running
 * total) so billed tokens are counted even when the transaction fails.
 */
async function classifyWithPolicy(
  request: ClassifyRequest,
  signal: AbortSignal | undefined,
  addUsage: (usage: AiTokenUsage) => AiTokenUsage,
): Promise<
  { ok: true; result: ClassifyResult } | { ok: false; failure: 'timeout' | 'bad_response' | 'truncated' | 'request' | 'budget' }
> {
  // One budget for the whole transaction — timeout and rate-limit retries
  // included — so the call/token caps are per transaction and usage is
  // reported once, as deltas of the cumulative total.
  const budget = { calls: 0, tokens: { input: 0, output: 0 } };
  let reported: AiTokenUsage = { input: 0, output: 0 };
  const report = (total: AiTokenUsage): void => {
    addUsage({ input: total.input - reported.input, output: total.output - reported.output });
    reported = { input: total.input, output: total.output };
  };
  let timeouts = 0;
  let rateLimits = 0;
  for (;;) {
    try {
      const result = await classifyTransaction({ ...request, budget });
      report(result.usage);
      return { ok: true, result };
    } catch (error) {
      if (!(error instanceof CategorizeError)) throw error;
      report(error.usage);
      // A caller abort surfaces as the adapter's `timeout`; it is not a
      // per-transaction failure and must not be retried.
      if (signal?.aborted) throw new CancelledFailure('categorize run cancelled');
      if (error.kind === 'timeout' && timeouts === 0) {
        timeouts++;
        continue;
      }
      if (error.kind === 'rate_limited' && rateLimits === 0) {
        rateLimits++;
        const wait = Math.min(error.retryAfterMs ?? DEFAULT_RATE_LIMIT_DELAY_MS, IN_CHUNK_RATE_LIMIT_WAIT_MS);
        await sleep(wait);
        if (signal?.aborted) throw new CancelledFailure('categorize run cancelled');
        continue;
      }
      if (
        error.kind === 'timeout' ||
        error.kind === 'bad_response' ||
        error.kind === 'truncated' ||
        error.kind === 'request' ||
        error.kind === 'budget'
      ) {
        return { ok: false, failure: error.kind };
      }
      throw error;
    }
  }
}

/** Run one chunk. Returns counts/ids/cursor only; the run-level failure policy lives in the caller. */
export async function runChunk(pool: Pool, params: ChunkParams): Promise<ChunkResult> {
  const owner = await store.runActorForBudget(pool, params.budgetId);
  if (!owner) return { problem: 'budget_missing' };
  const resolved = await resolveAiKey(pool, owner);
  if (!resolved.ok) return { problem: resolved.problem };
  const key = resolved.key;
  const model = key.model;
  if (!model) return { problem: 'no_model' };

  const progress: ChunkProgress = params.resume
    ? { ...params.resume, total: params.total, failedIds: [...params.resume.failedIds] }
    : emptyProgress(params.total, params.cursor);
  let cursor = progress.cursor;
  const report = (): void => {
    params.onProgress?.(progress);
  };
  const usage: AiTokenUsage = { input: progress.inputTokens, output: progress.outputTokens };
  const addUsage = (spent: AiTokenUsage): AiTokenUsage => {
    usage.input += spent.input;
    usage.output += spent.output;
    progress.inputTokens = usage.input;
    progress.outputTokens = usage.output;
    report();
    return usage;
  };

  // A retried attempt that already finished its share has nothing left to do.
  if (params.limit <= 0) {
    return {
      examined: progress.examined,
      nextCursor: cursor,
      suggested: progress.suggested,
      rule: progress.rule,
      empty: progress.empty,
      skipped: progress.skipped,
      failed: progress.failed,
      failedIds: progress.failedIds,
      usage,
    };
  }

  const candidates = await store.listCandidates(pool, params.budgetId, {
    snapshot: params.snapshot,
    cursor,
    limit: params.limit,
    force: params.force,
  });
  const choices = await store.listCategoryChoices(pool, params.budgetId);
  const allowedCategoryIds = new Set(choices.map((choice) => choice.id));
  const tools = createTools(pool, params.budgetId);
  const provider = providerFor(key);
  let consecutiveRequestFailures = 0;

  for (const transaction of candidates) {
    if (params.signal?.aborted) throw new CancelledFailure('categorize run cancelled');

    // A forced re-run includes rows with suggestions, but never a transaction
    // a person already decided: no model call, no overwrite.
    if (params.force && (await store.hasDecidedSuggestion(pool, transaction.id))) {
      progress.skipped++;
      cursor = { date: transaction.date, id: transaction.id };
      progress.cursor = cursor;
      progress.examined++;
      report();
      continue;
    }

    // The existing payee rule answers first; only the rest reaches the model.
    // Its category must still be visible (the rule filters deleted, not
    // hidden); otherwise the model gets the transaction like any other.
    const ruleCategory = await suggestedCategoryForPayee(pool, params.budgetId, transaction.payee_id);
    let written = false;
    if (ruleCategory && allowedCategoryIds.has(ruleCategory)) {
      written = await store.replaceSuggestions(pool, params.budgetId, transaction.id, [
        { categoryId: ruleCategory, confidence: 1, reason: null, source: 'payee_rule', provider: null, model: null },
      ]);
      if (written) {
        progress.rule++;
        await store.recordAttempt(pool, params.budgetId, transaction.id, {
          outcome: 'suggested',
          errorKind: null,
          model: null,
          reset: params.force,
        });
      }
    } else {
      const outcome = await withKeyLock(owner, () =>
        classifyWithPolicy(
          {
            provider,
            model,
            transaction,
            tools,
            allowedCategoryIds,
            signal: params.signal,
          },
          params.signal,
          addUsage,
        ),
      );
      if (params.signal?.aborted) throw new CancelledFailure('categorize run cancelled');
      if (!outcome.ok) {
        progress.failed++;
        progress.failedIds.push(transaction.id);
        await store.recordAttempt(pool, params.budgetId, transaction.id, {
          outcome: 'failed',
          errorKind: outcome.failure,
          model,
          reset: params.force,
        });
        if (outcome.failure === 'request') {
          consecutiveRequestFailures++;
          // The same request-shape 400 on N transactions is a request bug, not
          // N bad transactions: stop instead of recording a successful run
          // where every transaction failed.
          if (consecutiveRequestFailures >= CATEGORIZE_MAX_CONSECUTIVE_REQUEST_FAILURES) {
            throw new CategorizeError('systematic', usage);
          }
        } else {
          consecutiveRequestFailures = 0;
        }
      } else {
        consecutiveRequestFailures = 0;
        written = await store.replaceSuggestions(
          pool,
          params.budgetId,
          transaction.id,
          outcome.result.suggestions.map((suggestion) => ({
            categoryId: suggestion.categoryId,
            confidence: suggestion.confidence,
            reason: suggestion.reason,
            source: 'ai' as const,
            provider: provider.id,
            model: outcome.result.model,
          })),
        );
        if (written) {
          if (outcome.result.suggestions.length > 0) {
            progress.suggested++;
            await store.recordAttempt(pool, params.budgetId, transaction.id, {
              outcome: 'suggested',
              errorKind: null,
              model: outcome.result.model,
              reset: params.force,
            });
          } else {
            progress.empty++;
            await store.recordAttempt(pool, params.budgetId, transaction.id, {
              outcome: 'no_suggestion',
              errorKind: null,
              model: outcome.result.model,
              reset: params.force,
            });
          }
        }
      }
    }
    if (!written) progress.skipped++;
    cursor = { date: transaction.date, id: transaction.id };
    progress.cursor = cursor;
    progress.examined++;
    report();
  }

  return {
    examined: progress.examined,
    nextCursor: cursor,
    suggested: progress.suggested,
    rule: progress.rule,
    empty: progress.empty,
    skipped: progress.skipped,
    failed: progress.failed,
    failedIds: progress.failedIds,
    usage,
  };
}
