/**
 * Categorize workflow (runs in the Temporal sandbox: ONLY @temporalio/workflow,
 * type-only imports and pure files — no pg, no Bun). Re-exported from
 * jobs/workflows/index.ts, the single bundle the worker loads.
 *
 * Shape: prepare (key availability, candidate window + its newest row) then
 * chunk after chunk along a keyset cursor until the window is walked. The
 * cursor is fixed against the snapshot taken at prepare, so rows inserted or
 * removed mid-run can neither be billed twice (offset shift) nor skipped. A
 * chunk that loses its key mid-run ends the run with the same user-safe
 * sentence as prepare; per-transaction failures are already counted inside the
 * chunk result.
 *
 * Cost bounds live in ./jobspec.ts: a small output cap per turn, a per-
 * transaction call/token cap, a chunk size, and CATEGORIZE_RUN_LIMIT
 * transactions per run (the remainder waits for the next run).
 *
 * Retry policy for provider-calling activities lives on the proxy below (the
 * `-ai` queue): its start-to-close is derived from the per-call deadline, the
 * per-transaction call cap and the chunk size (CATEGORIZE_CHUNK_TIMEOUT_MS =
 * 31 min), so a slow model cannot make Temporal time out a chunk that is still
 * within its own budget. A retried attempt resumes from its heartbeat cursor
 * and token totals. Auth/permanent are non-retryable ApplicationFailures; rate
 * limits carry the provider's own retry-after; timeouts never reach this
 * policy — the chunk retries a timeout once per transaction (see ./chunk.ts).
 */
import { ActivityFailure, ApplicationFailure, proxyActivities, workflowInfo } from '@temporalio/workflow';

import type { CategorizeActivities } from './activities';
import type { ChunkOutcome } from './chunk';
import {
  AI_QUEUE_SUFFIX,
  CATEGORIZE_CHUNK_SIZE,
  CATEGORIZE_CHUNK_TIMEOUT_MS,
  forceFromInput,
} from './jobspec';
import { CATEGORIZE_FAILURE_MESSAGES, CATEGORIZE_SKIP_MESSAGES, type CategorizeSkipProblem } from './messages';
import { runTracked, type JobArgs } from '../jobs/workflows/tracked';

type CandidateCursor = { date: string; id: string };

function failureType(error: unknown): string | undefined {
  if (error instanceof ActivityFailure && error.cause instanceof ApplicationFailure) return error.cause.type ?? undefined;
  return error instanceof ApplicationFailure ? (error.type ?? undefined) : undefined;
}

/** User-safe run message for a failure — never raw provider text. */
export function userMessageForFailure(error: unknown): string | undefined {
  const type = failureType(error);
  return type ? CATEGORIZE_FAILURE_MESSAGES[type] : undefined;
}

type RunSummary = {
  total: number;
  /** Candidates left for the next run because of CATEGORIZE_RUN_LIMIT (0 = none). */
  remaining: number;
  done: number;
  suggested: number;
  rule: number;
  empty: number;
  skipped: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  /** Set when the run stopped early (no usable key); the message is in user_message. */
  stopped: CategorizeSkipProblem | null;
};

export async function categorizeRun(args: JobArgs): Promise<RunSummary | undefined> {
  const budgetId = args.subjectKey;
  const provider = proxyActivities<CategorizeActivities>({
    taskQueue: `${workflowInfo().taskQueue}${AI_QUEUE_SUFFIX}`,
    // CATEGORIZE_CHUNK_SIZE x CLASSIFY_MAX_CALLS x per-call deadline + one
    // in-chunk 429 wait; see ./jobspec.ts.
    startToCloseTimeout: CATEGORIZE_CHUNK_TIMEOUT_MS,
    heartbeatTimeout: '30 seconds',
    retry: { initialInterval: '30 seconds', backoffCoefficient: 2, maximumInterval: '15 minutes', maximumAttempts: 5 },
  });
  const local = proxyActivities<CategorizeActivities>({
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 5, initialInterval: '1 second', maximumInterval: '30 seconds' },
  });

  return runTracked(
    args,
    async () => {
      const summary: RunSummary = {
        total: 0,
        remaining: 0,
        done: 0,
        suggested: 0,
        rule: 0,
        empty: 0,
        skipped: 0,
        failed: 0,
        input_tokens: 0,
        output_tokens: 0,
        stopped: null,
      };
      const force = forceFromInput(args.input);
      const prepared = await local.categorizePrepare({ runId: args.runId, budgetId, force });
      if ('problem' in prepared) {
        summary.stopped = prepared.problem;
        return summary;
      }
      summary.total = prepared.total;
      summary.remaining = prepared.remaining;
      const snapshot = prepared.snapshot;
      if (!snapshot) return summary;

      let cursor: CandidateCursor | null = null;
      while (summary.done < summary.total) {
        const chunk: ChunkOutcome = await provider.categorizeChunk({
          runId: args.runId,
          budgetId,
          force,
          limit: CATEGORIZE_CHUNK_SIZE,
          cursor,
          snapshot,
          doneBefore: summary.done,
          total: summary.total,
        });
        if ('problem' in chunk) {
          summary.stopped = chunk.problem;
          return summary;
        }
        summary.done += chunk.examined;
        summary.suggested += chunk.suggested;
        summary.rule += chunk.rule;
        summary.empty += chunk.empty;
        summary.skipped += chunk.skipped;
        summary.failed += chunk.failed;
        summary.input_tokens += chunk.usage.input;
        summary.output_tokens += chunk.usage.output;
        cursor = chunk.nextCursor;
        // A shrunken window (transactions categorized meanwhile) can leave
        // nothing to read; the run is done with what it saw.
        if (chunk.examined === 0) break;
      }
      return summary;
    },
    {
      failureUserMessage: userMessageForFailure,
      successUserMessage: (result) => (result?.stopped ? CATEGORIZE_SKIP_MESSAGES[result.stopped] : undefined),
    },
  );
}
