/**
 * Categorize activities (Temporal side; deep-imported by api/src/worker.ts).
 * `trackedAttempt` comes from the jobs ledger activities and is injected so
 * this feature never imports jobs internals.
 *
 * The activity is the boundary that owns Temporal specifics:
 *  - cancellation aborts the in-flight provider call through an AbortSignal;
 *  - a timer heartbeats during long model calls (a chat call can outlive the
 *    heartbeat timeout; heartbeats must continue while it is awaited), and the
 *    heartbeat payload doubles as the chunk's resume state: a retried attempt
 *    continues after the last *finished* transaction, so finished work is
 *    never paid for twice;
 *  - per-transaction failures stay inside ./chunk.ts; auth/permanent/rate/
 *    transient failures become ApplicationFailures whose `type` the workflow
 *    turns into a user-safe run message.
 *
 * Nothing here returns or logs a key, and no error text from a provider is
 * kept: results carry counts and ids, failures fixed sentences. For an
 * unexpected error only its database error CODE (22P02, 23505 …) is logged,
 * never its message.
 */
import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import type { Pool } from 'pg';

import { z } from '@shared/zod';

import type { JobContext } from '../jobs';
import {
  runChunk,
  prepareRun,
  type ChunkOutcome,
  type ChunkProgress,
  type PrepareOutcome,
} from './chunk';
import { CategorizeError } from './errors';
import { DEFAULT_RATE_LIMIT_DELAY_MS, MAX_RATE_LIMIT_DELAY_MS } from './jobspec';
import type { CandidateCursor } from './store';
import { recordRunProgress } from './store';

const HEARTBEAT_EVERY_MS = 10_000;

type Tracked = <T>(runId: string, body: (ctx: JobContext) => Promise<T>) => Promise<T>;

/** The activity contract the workflow proxies (shipped in the Temporal signature). */
export interface CategorizeActivities {
  categorizePrepare(args: { runId: string; budgetId: string; force: boolean }): Promise<PrepareOutcome>;
  categorizeChunk(args: {
    runId: string;
    budgetId: string;
    force: boolean;
    limit: number;
    cursor: CandidateCursor | null;
    snapshot: CandidateCursor;
    /** Run-level examined count before this chunk, for the ledger log. */
    doneBefore: number;
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
      case 'systematic':
        // The provider refused every request in a row: a request-shape bug.
        // Ending the run (non-retryable) is the safe path; the workflow shows
        // the fixed sentence below.
        return ApplicationFailure.create({ message: error.message, type: 'AiSystematic', nonRetryable: true });
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

const cursorSchema = z.object({ date: z.string(), id: z.string() });
const progressSchema = z.object({
  examined: z.number().int().min(0),
  total: z.number().int().min(0),
  cursor: cursorSchema.nullable(),
  suggested: z.number().int().min(0),
  rule: z.number().int().min(0),
  empty: z.number().int().min(0),
  skipped: z.number().int().min(0),
  failed: z.number().int().min(0),
  failedIds: z.array(z.string()),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});

/** The heartbeat payload of a previous attempt, or null (fresh or malformed). */
export function readProgress(details: unknown): ChunkProgress | null {
  const parsed = progressSchema.safeParse(details);
  return parsed.success ? parsed.data : null;
}

/**
 * What a failure may put in the ledger: its kind, plus the Postgres error code
 * when it is a driver error. Codes are diagnostics, not content (22P02 is not
 * a key); messages are never logged.
 */
export function failureLogFields(error: unknown): { kind: string; pg_code?: string } {
  if (error instanceof CategorizeError) return { kind: error.kind };
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return { kind: 'internal', pg_code: error.code };
  }
  return { kind: 'internal' };
}

export function createCategorizeActivities(db: Pool, trackedAttempt: Tracked): CategorizeActivities {
  return {
    /** Key availability and the candidate window; no provider call, no key in the result. */
    async categorizePrepare(args: { runId: string; budgetId: string; force: boolean }): Promise<PrepareOutcome> {
      return trackedAttempt(args.runId, async (ctx) => {
        const result = await prepareRun(db, args.budgetId, args.force);
        if ('problem' in result) {
          if (result.problem === 'budget_missing') {
            throw ApplicationFailure.create({ message: 'budget no longer exists', type: 'BudgetMissing', nonRetryable: true });
          }
          await ctx.log('warn', 'categorize run has no usable AI key', { problem: result.problem });
          return { problem: result.problem };
        }
        await ctx.log('info', 'categorize run prepared', { total: result.total, remaining: result.remaining });
        // Make the total visible to categorize_run_status before the first chunk.
        await recordRunProgress(db, args.runId, args.budgetId, 0, result.total);
        return result;
      });
    },

    /** Classify the next window of transactions. Returns counts/ids/cursor only. */
    async categorizeChunk(args: {
      runId: string;
      budgetId: string;
      force: boolean;
      limit: number;
      cursor: CandidateCursor | null;
      snapshot: CandidateCursor;
      doneBefore: number;
      total: number;
    }): Promise<ChunkOutcome> {
      return trackedAttempt(args.runId, async (ctx) => {
        const abort = new AbortController();
        // Cancel the in-flight provider call when Temporal cancels the activity.
        void Context.current().cancelled.catch(() => abort.abort());
        const resumed = readProgress(Context.current().info.heartbeatDetails);
        let progress: ChunkProgress = resumed ?? {
          examined: 0,
          total: args.total,
          cursor: args.cursor,
          suggested: 0,
          rule: 0,
          empty: 0,
          skipped: 0,
          failed: 0,
          failedIds: [],
          inputTokens: 0,
          outputTokens: 0,
        };
        // Persist progress for categorize_run_status (Temporal's heartbeat
        // payload is not queryable from the API). Serialized writes and a
        // time gate keep it to one small upsert per heartbeat interval.
        let lastPersisted = 0;
        let writes: Promise<void> = Promise.resolve();
        const persist = (done: number, total: number): void => {
          const now = Date.now();
          if (now - lastPersisted < HEARTBEAT_EVERY_MS) return;
          lastPersisted = now;
          writes = writes
            .then(() => recordRunProgress(db, args.runId, args.budgetId, done, total))
            .catch(() => undefined);
        };
        const timer = setInterval(() => {
          // A tick can race the activity's completion; a heartbeat there must
          // never crash the worker.
          try {
            Context.current().heartbeat(progress);
            persist(args.doneBefore + progress.examined, args.total);
          } catch {
            /* activity already finished */
          }
        }, HEARTBEAT_EVERY_MS);
        try {
          const result = await runChunk(db, {
            budgetId: args.budgetId,
            force: args.force,
            snapshot: args.snapshot,
            cursor: resumed?.cursor ?? args.cursor,
            // A retried attempt only has the part it did not finish left.
            limit: Math.max(0, args.limit - (resumed?.examined ?? 0)),
            total: args.total,
            resume: resumed ?? undefined,
            signal: abort.signal,
            onProgress: (next) => {
              progress = { ...next };
              Context.current().heartbeat(progress);
              persist(args.doneBefore + progress.examined, args.total);
            },
          });
          if ('problem' in result) {
            if (result.problem === 'budget_missing') {
              throw ApplicationFailure.create({ message: 'budget no longer exists', type: 'BudgetMissing', nonRetryable: true });
            }
            await ctx.log('warn', 'categorize run lost its AI key mid-run', {
              problem: result.problem,
              done: args.doneBefore + progress.examined,
            });
            return result;
          }
          await ctx.log('info', 'categorize chunk done', {
            done: args.doneBefore + result.examined,
            total: args.total,
            examined: result.examined,
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
          // retried. Counts and codes only; no provider text and no key.
          await ctx.log('warn', 'categorize chunk stopped', {
            done: args.doneBefore + progress.examined,
            total: args.total,
            input_tokens: progress.inputTokens,
            output_tokens: progress.outputTokens,
            ...failureLogFields(error),
          });
          throw toActivityFailure(error);
        } finally {
          clearInterval(timer);
          // Final row for this chunk, after any queued writes, so status shows
          // the completed count immediately.
          await writes;
          await recordRunProgress(db, args.runId, args.budgetId, args.doneBefore + progress.examined, args.total).catch(
            () => undefined,
          );
        }
      });
    },
  };
}
