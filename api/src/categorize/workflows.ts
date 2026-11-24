/**
 * Categorize workflow (runs in the Temporal sandbox: ONLY @temporalio/workflow,
 * type-only imports and pure files — no pg, no Bun). Re-exported from
 * jobs/workflows/index.ts, the single bundle the worker loads.
 *
 * Shape: prepare (key availability + candidate count) then chunk after chunk
 * until the prepared window is walked. A chunk that loses its key mid-run ends
 * the run with the same user-safe sentence as prepare. Run-level failures are
 * the activities' ApplicationFailure types mapped to fixed sentences; the
 * per-transaction failures are already counted inside the chunk result.
 *
 * Retry policy for provider-calling activities lives on the proxy below (the
 * `-ai` queue): 30s initial, x2, max 15m, 5 attempts. Auth/permanent are
 * non-retryable ApplicationFailures; rate limits carry the provider's own
 * retry-after; timeouts never reach this policy — the chunk retries a timeout
 * once per transaction and counts it failed (see ./chunk.ts).
 */
import { ActivityFailure, ApplicationFailure, proxyActivities, workflowInfo } from '@temporalio/workflow';

import type { CategorizeActivities } from './activities';
import { AI_QUEUE_SUFFIX, CATEGORIZE_CHUNK_SIZE } from './jobspec';
import { CATEGORIZE_FAILURE_MESSAGES, CATEGORIZE_SKIP_MESSAGES, type CategorizeSkipProblem } from './messages';
import { runTracked, type JobArgs } from '../jobs/workflows/tracked';

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
    // A chunk is up to CATEGORIZE_CHUNK_SIZE transactions, each a few model
    // turns; liveness is the heartbeat, not this bound.
    startToCloseTimeout: '30 minutes',
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
      const prepared = await local.categorizePrepare({ runId: args.runId, budgetId });
      if ('problem' in prepared) {
        summary.stopped = prepared.problem;
        return summary;
      }
      summary.total = prepared.total;

      while (summary.done < summary.total) {
        const chunk = await provider.categorizeChunk({
          runId: args.runId,
          budgetId,
          offset: summary.done,
          limit: CATEGORIZE_CHUNK_SIZE,
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
        // A shrunken candidate set (transactions categorized meanwhile) can
        // leave an empty window; the run is done with what it saw.
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
