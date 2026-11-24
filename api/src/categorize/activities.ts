/**
 * Categorize activities (Temporal side; deep-imported by api/src/worker.ts).
 * `trackedAttempt` comes from the jobs ledger activities and is injected so
 * this feature never imports jobs internals.
 *
 * The activity is the boundary that owns Temporal specifics:
 *  - cancellation aborts the in-flight provider call through an AbortSignal;
 *  - a timer heartbeats during long model calls (a chat call can outlive the
 *    heartbeat timeout; heartbeats must continue while it is awaited);
 *  - per-transaction failures stay inside ./chunk.ts; auth/permanent/rate/
 *    transient failures become ApplicationFailures whose `type` the workflow
 *    turns into a user-safe run message.
 *
 * Nothing here returns or logs a key, and no error text from a provider is
 * kept: results carry counts and ids, failures fixed sentences.
 */
import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import type { Pool } from 'pg';

import type { JobContext } from '../jobs';
import { runChunk, prepareRun, type ChunkOutcome, type ChunkProgress, type PrepareOutcome } from './chunk';
import { CategorizeError } from './errors';
import { DEFAULT_RATE_LIMIT_DELAY_MS, MAX_RATE_LIMIT_DELAY_MS } from './jobspec';

const HEARTBEAT_EVERY_MS = 10_000;

type Tracked = <T>(runId: string, body: (ctx: JobContext) => Promise<T>) => Promise<T>;

/** The activity contract the workflow proxies (shipped in the Temporal signature). */
export interface CategorizeActivities {
  categorizePrepare(args: { runId: string; budgetId: string }): Promise<PrepareOutcome>;
  categorizeChunk(args: {
    runId: string;
    budgetId: string;
    offset: number;
    limit: number;
    total: number;
  }): Promise<ChunkOutcome>;
}

/** Any failure → the ApplicationFailure the retry policy and workflow understand. */
export function toActivityFailure(error: unknown): Error {
  if (error instanceof ApplicationFailure || error instanceof CancelledFailure) return error;
  if (error instanceof CategorizeError) {
    switch (error.kind) {
      case 'auth':
        return ApplicationFailure.create({ message: error.message, type: 'AiAuth', nonRetryable: true });
      case 'permanent':
        return ApplicationFailure.create({ message: error.message, type: 'AiPermanent', nonRetryable: true });
      case 'rate_limited':
        return ApplicationFailure.create({
          message: error.message,
          type: 'AiRateLimited',
          nextRetryDelay: Math.min(error.retryAfterMs ?? DEFAULT_RATE_LIMIT_DELAY_MS, MAX_RATE_LIMIT_DELAY_MS),
        });
      default:
        return ApplicationFailure.create({ message: error.message, type: 'AiTransient' });
    }
  }
  // Unknown failures (bugs, driver errors): retryable, and never their text.
  return ApplicationFailure.create({ message: 'categorize activity failed', type: 'AiTransient' });
}

export function createCategorizeActivities(db: Pool, trackedAttempt: Tracked): CategorizeActivities {
  return {
    /** Key availability and the candidate count; no provider call, no key in the result. */
    async categorizePrepare(args: { runId: string; budgetId: string }): Promise<PrepareOutcome> {
      return trackedAttempt(args.runId, async (ctx) => {
        const result = await prepareRun(db, args.budgetId);
        if ('problem' in result) {
          if (result.problem === 'budget_missing') {
            throw ApplicationFailure.create({ message: 'budget no longer exists', type: 'BudgetMissing', nonRetryable: true });
          }
          await ctx.log('warn', 'categorize run has no usable AI key', { problem: result.problem });
          return { problem: result.problem };
        }
        await ctx.log('info', 'categorize run prepared', { total: result.total });
        return { total: result.total };
      });
    },

    /** Classify the next window of transactions. Returns counts/ids only. */
    async categorizeChunk(args: {
      runId: string;
      budgetId: string;
      offset: number;
      limit: number;
      total: number;
    }): Promise<ChunkOutcome> {
      return trackedAttempt(args.runId, async (ctx) => {
        const abort = new AbortController();
        // Cancel the in-flight provider call when Temporal cancels the activity.
        void Context.current().cancelled.catch(() => abort.abort());
        let progress: ChunkProgress = {
          done: args.offset,
          total: args.total,
          suggested: 0,
          rule: 0,
          failed: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        const timer = setInterval(() => {
          // A tick can race the activity's completion; a heartbeat there must
          // never crash the worker.
          try {
            Context.current().heartbeat(progress);
          } catch {
            /* activity already finished */
          }
        }, HEARTBEAT_EVERY_MS);
        try {
          const result = await runChunk(db, {
            budgetId: args.budgetId,
            offset: args.offset,
            limit: args.limit,
            total: args.total,
            signal: abort.signal,
            onProgress: (next) => {
              progress = { ...next };
              Context.current().heartbeat(progress);
            },
          });
          if ('problem' in result) {
            if (result.problem === 'budget_missing') {
              throw ApplicationFailure.create({ message: 'budget no longer exists', type: 'BudgetMissing', nonRetryable: true });
            }
            await ctx.log('warn', 'categorize run lost its AI key mid-run', { problem: result.problem, done: progress.done });
            return result;
          }
          progress = { ...progress, done: args.offset + result.examined };
          await ctx.log('info', 'categorize chunk done', {
            done: progress.done,
            total: args.total,
            suggested: result.suggested,
            rule: result.rule,
            empty: result.empty,
            skipped: result.skipped,
            failed: result.failed,
            input_tokens: result.usage.input,
            output_tokens: result.usage.output,
          });
          return result;
        } catch (error) {
          // A stopped chunk keeps its last heartbeat totals in the ledger too:
          // billed tokens so far are reported even when the run fails or is
          // retried. Counts only; no provider text and no key.
          await ctx.log('warn', 'categorize chunk stopped', {
            done: progress.done,
            total: args.total,
            input_tokens: progress.inputTokens,
            output_tokens: progress.outputTokens,
            kind: error instanceof CategorizeError ? error.kind : 'internal',
          });
          throw toActivityFailure(error);
        } finally {
          clearInterval(timer);
        }
      });
    },
  };
}
