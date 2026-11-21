/**
 * Shared workflow plumbing for every job type (runs inside the Temporal
 * workflow sandbox: imports ONLY @temporalio/workflow + types). Feature
 * workflow files (e.g. server/connections/workflows.ts) import this one file —
 * a documented lint seam — and are re-exported from ./index.ts.
 */
import { CancellationScope, isCancellation, proxyActivities } from '@temporalio/workflow';

import type { LedgerActivities } from '../activities';
import { JOB_USER_MESSAGES } from '../user-messages';

export type JobArgs = {
  runId: string;
  jobType: string;
  subjectKey: string;
  tenantId: string | null;
  input: unknown;
};

export const ledger = proxyActivities<LedgerActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 10, initialInterval: '1 second', maximumInterval: '30 seconds' },
});

export interface TrackedOptions<T> {
  /** User-safe text stored on the run when the body fails (never raw error text). */
  failureUserMessage?: (e: unknown) => string | undefined;
  /** User-safe text stored on a succeeded run (e.g. a "paused until next month" notice). */
  successUserMessage?: (result: T) => string | undefined;
}

/**
 * Shared shape for every job workflow: mark running, run the tracked work
 * activity, then ALWAYS close the run in the ledger (even on cancel/failure)
 * with retried, non-cancellable activities.
 */
export async function runTracked<T>(args: JobArgs, body: () => Promise<T>, opts: TrackedOptions<T> = {}): Promise<T | undefined> {
  const started = await ledger.markRunStarted(args.runId);
  if (!started) return undefined; // cancelled (or closed) while queued
  try {
    const result = await body();
    await ledger.closeRun({ runId: args.runId, status: 'succeeded', result, userMessage: opts.successUserMessage?.(result) ?? null });
    return result;
  } catch (e) {
    const cancelled = isCancellation(e);
    await CancellationScope.nonCancellable(() =>
      ledger.closeRun({
        runId: args.runId,
        status: cancelled ? 'cancelled' : 'failed',
        errorMessage: failureMessage(e),
        userMessage: cancelled ? JOB_USER_MESSAGES.cancelled : (opts.failureUserMessage?.(e) ?? JOB_USER_MESSAGES.failed),
      }),
    );
    throw e;
  }
}

/** Activity failures wrap the real error as `cause`; surface that one. */
export function failureMessage(e: unknown): string {
  const cause = (e as { cause?: { message?: string } } | null)?.cause?.message;
  return cause ?? (e instanceof Error ? e.message : String(e));
}
