/**
 * Connections workflows (run in the Temporal sandbox: ONLY @temporalio/workflow,
 * type-only imports and pure files — no pg, no Bun). Re-exported from
 * server/jobs/workflows/index.ts, the single bundle the worker loads.
 *
 * Retry policy for provider-calling activities (Q17): 30s initial, x2, max 15m,
 * 5 attempts. Auth/permanent failures are non-retryable ApplicationFailures
 * thrown by the activity; rate limits are retryable with the provider's own
 * `nextRetryDelay` (RateLimit-Reset). Provider-calling activities run on the
 * `<queue>-pluggy` task queue, which the worker rate-limits (~1/s).
 */
import { ActivityFailure, ApplicationFailure, CancellationScope, isCancellation, proxyActivities, sleep, workflowInfo } from '@temporalio/workflow';

import type { ConnectionsActivities } from './activities';
import { PAUSED_RUN_MESSAGE, USER_MESSAGES, type AggregatorErrorKind } from './errors';
import { connectionIdFromSubject, PLUGGY_QUEUE_SUFFIX, type ConnectionSyncInput } from './jobspec';
import { runTracked, type JobArgs } from '../jobs/workflows/tracked';

/** ApplicationFailure.type values thrown by the activities → taxonomy kind. */
export const FAILURE_KIND: Record<string, AggregatorErrorKind> = {
  ConnectionAuth: 'auth',
  RateLimited: 'rate_limited',
  Transient: 'transient',
  Permanent: 'permanent',
};

function failureType(e: unknown): string | undefined {
  return e instanceof ActivityFailure && e.cause instanceof ApplicationFailure ? (e.cause.type ?? undefined) : undefined;
}

/** User-safe run message for a failure — never raw provider/driver text. */
export function userMessageForFailure(e: unknown): string {
  const kind = FAILURE_KIND[failureType(e) ?? ''];
  return kind ? USER_MESSAGES[kind] : USER_MESSAGES.permanent;
}

const POLL_IDLE_MS = 3_000;
const MAX_IDLE_POLLS = 200; // ~10 minutes, then proceed (the row lock still serializes writes)

export async function connectionsSync(args: JobArgs): Promise<unknown> {
  const { mode } = (args.input ?? { mode: 'sync' }) as ConnectionSyncInput;
  const connectionId = connectionIdFromSubject(args.subjectKey);
  const queue = `${workflowInfo().taskQueue}${PLUGGY_QUEUE_SUFFIX}`;
  const provider = proxyActivities<ConnectionsActivities>({
    taskQueue: queue,
    startToCloseTimeout: '10 minutes',
    heartbeatTimeout: '30 seconds',
    retry: { initialInterval: '30 seconds', backoffCoefficient: 2, maximumInterval: '15 minutes', maximumAttempts: 5 },
  });
  const local = proxyActivities<ConnectionsActivities>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 5, initialInterval: '1 second', maximumInterval: '30 seconds' },
  });

  return runTracked(
    args,
    async () => {
      if (mode === 'reimport') {
        // Queue after an in-flight plain sync of the same connection.
        for (let i = 0; i < MAX_IDLE_POLLS && (await local.connectionsOtherSyncActive({ runId: args.runId, connectionId })); i++) {
          await sleep(POLL_IDLE_MS);
        }
      }
      try {
        return await provider.connectionsSyncWork({ runId: args.runId, connectionId, mode });
      } catch (e) {
        if (!isCancellation(e)) {
          await CancellationScope.nonCancellable(() =>
            local.connectionsMarkFailed({ connectionId, failureType: failureType(e) ?? 'Permanent' }),
          );
        }
        throw e;
      }
    },
    {
      failureUserMessage: userMessageForFailure,
      successUserMessage: (r) => {
        const skipped = r && typeof r === 'object' && 'skipped' in r ? r.skipped : undefined;
        if (skipped === 'quota_exhausted') return USER_MESSAGES.quota_exhausted;
        if (skipped === 'paused') return PAUSED_RUN_MESSAGE;
        return undefined;
      },
    },
  );
}

/** Scheduled every 6h: enqueue syncs only for connections the provider says changed. */
export async function connectionsSweep(): Promise<{ checked: number; enqueued: number; errors: number }> {
  const local = proxyActivities<ConnectionsActivities>({
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 5, initialInterval: '5 seconds', maximumInterval: '1 minute' },
  });
  const provider = proxyActivities<ConnectionsActivities>({
    taskQueue: `${workflowInfo().taskQueue}${PLUGGY_QUEUE_SUFFIX}`,
    startToCloseTimeout: '2 minutes',
    retry: { initialInterval: '30 seconds', backoffCoefficient: 2, maximumInterval: '15 minutes', maximumAttempts: 3 },
  });
  const targets = await local.connectionsSweepList();
  const out = { checked: 0, enqueued: 0, errors: 0 };
  for (const t of targets) {
    out.checked++;
    try {
      if ((await provider.connectionsSweepCheck({ connectionId: t.id })) === 'enqueued') out.enqueued++;
    } catch {
      out.errors++; // one broken connection never stops the sweep
    }
  }
  return out;
}
