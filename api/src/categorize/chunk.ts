/**
 * One chunk of a categorize run: pick the next window of uncategorized
 * transactions of ONE budget, answer the existing payee rule first, send only
 * the rest to the model, and write the suggestions. Runs inside a Temporal
 * activity (./activities.ts); the workflow only sees counts and ids.
 *
 * Failure policy is here, by AiProviderError kind (see ./errors.ts):
 *  - timeout      retried once for that transaction, then counted failed and
 *                 the chunk continues (a timed-out generation may be billed).
 *  - bad_response counted failed, chunk continues.
 *  - auth, permanent       thrown → the activity fails the run (non-retryable).
 *  - rate_limited, transient thrown → the activity is retried by Temporal
 *                 (rate limits honor the provider's retry-after).
 * One failing transaction never fails the chunk.
 */
import { CancelledFailure } from '@temporalio/common';
import type { Pool } from 'pg';

import { providerFor, resolveAiKey, type AiTokenUsage } from '../ai';
import { suggestedCategoryForPayee } from '../budget';
import type { Queryable } from '../core/db';
import { classifyTransaction, type ClassifyRequest, type ClassifyResult } from './agent';
import { CategorizeError } from './errors';
import type { CategorizeSkipProblem } from './messages';
import * as store from './store';
import { createTools } from './tools';

export type PrepareOutcome = { total: number } | { problem: CategorizeSkipProblem };
/** What prepare reports for a budget that no longer exists (the activity fails the run). */
export type PrepareResult = PrepareOutcome | { problem: 'budget_missing' };

export type ChunkProgress = {
  done: number;
  total: number;
  suggested: number;
  rule: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
};

export type ChunkOutcome =
  | { problem: CategorizeSkipProblem }
  | {
      examined: number;
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
  offset: number;
  limit: number;
  /** Candidate count from prepare, for the heartbeat's done/total. */
  total: number;
  signal?: AbortSignal;
  /** Sync hook after every transaction (the activity mirrors it into heartbeats). */
  onProgress?: (progress: ChunkProgress) => void;
};

/** Resolve the owner's key (no provider call) and count what a run would classify. */
export async function prepareRun(db: Queryable, budgetId: string): Promise<PrepareResult> {
  const owner = await store.budgetOwner(db, budgetId);
  if (!owner) return { problem: 'budget_missing' };
  const resolved = await resolveAiKey(db, owner);
  if (!resolved.ok) return { problem: resolved.problem };
  if (!resolved.key.model) return { problem: 'no_model' };
  return { total: await store.countCandidates(db, budgetId) };
}

/**
 * Classify one transaction, retrying a timeout at most once. Returns a
 * per-transaction failure for timeout/bad_response; rethrows auth/permanent/
 * rate_limited/transient for the activity's run-level policy. Every attempt's
 * usage is added through `addUsage` so billed tokens are counted even when the
 * transaction fails.
 */
async function classifyWithPolicy(
  request: ClassifyRequest,
  signal: AbortSignal | undefined,
  addUsage: (usage: AiTokenUsage) => void,
): Promise<{ ok: true; result: ClassifyResult } | { ok: false; failure: 'timeout' | 'bad_response' }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, result: await classifyTransaction(request) };
    } catch (error) {
      if (!(error instanceof CategorizeError)) throw error;
      addUsage(error.usage);
      // A caller abort surfaces as the adapter's `timeout`; it is not a
      // per-transaction failure and must not be retried.
      if (signal?.aborted) throw new CancelledFailure('categorize run cancelled');
      if (error.kind === 'timeout' && attempt === 1) continue;
      if (error.kind === 'timeout' || error.kind === 'bad_response') return { ok: false, failure: error.kind };
      throw error;
    }
  }
}

/** Run one chunk. Returns counts/ids only; the run-level failure policy lives in the caller. */
export async function runChunk(pool: Pool, params: ChunkParams): Promise<ChunkResult> {
  const owner = await store.budgetOwner(pool, params.budgetId);
  if (!owner) return { problem: 'budget_missing' };
  const resolved = await resolveAiKey(pool, owner);
  if (!resolved.ok) return { problem: resolved.problem };
  const key = resolved.key;
  if (!key.model) return { problem: 'no_model' };

  const candidates = await store.listCandidates(pool, params.budgetId, params.offset, params.limit);
  const choices = await store.listCategoryChoices(pool, params.budgetId);
  const allowedCategoryIds = new Set(choices.map((choice) => choice.id));
  const tools = createTools(pool, params.budgetId);
  const provider = providerFor(key);

  const usage: AiTokenUsage = { input: 0, output: 0 };
  const addUsage = (spent: AiTokenUsage): void => {
    usage.input += spent.input;
    usage.output += spent.output;
  };
  const progress: ChunkProgress = { done: params.offset, total: params.total, suggested: 0, rule: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
  const report = (): void => {
    progress.inputTokens = usage.input;
    progress.outputTokens = usage.output;
    params.onProgress?.(progress);
  };

  const counts = { suggested: 0, rule: 0, empty: 0, skipped: 0, failed: 0, failedIds: [] as string[] };
  for (const [index, transaction] of candidates.entries()) {
    if (params.signal?.aborted) throw new CancelledFailure('categorize run cancelled');

    // The existing payee rule answers first; only the rest reaches the model.
    const ruleCategory = await suggestedCategoryForPayee(pool, params.budgetId, transaction.payee_id);
    let written = false;
    if (ruleCategory) {
      written = await store.replaceSuggestions(pool, params.budgetId, transaction.id, [
        { categoryId: ruleCategory, confidence: 1, reason: null, source: 'payee_rule', provider: null, model: null },
      ]);
      if (written) counts.rule++;
    } else {
      const outcome = await classifyWithPolicy(
        {
          provider,
          model: key.model,
          transaction,
          tools,
          allowedCategoryIds,
          signal: params.signal,
        },
        params.signal,
        addUsage,
      );
      if (params.signal?.aborted) throw new CancelledFailure('categorize run cancelled');
      if (!outcome.ok) {
        counts.failed++;
        counts.failedIds.push(transaction.id);
      } else {
        addUsage(outcome.result.usage);
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
          if (outcome.result.suggestions.length > 0) counts.suggested++;
          else counts.empty++;
        }
      }
    }
    if (!written) counts.skipped++;
    progress.done = params.offset + index + 1;
    progress.suggested = counts.suggested;
    progress.rule = counts.rule;
    progress.failed = counts.failed;
    report();
  }

  return { examined: candidates.length, ...counts, usage };
}
