/**
 * Activities the worker hosts (SDK import #2). They are the ledger's writers:
 * the executor updates job_runs / job_attempts / job_logs itself, so the
 * ledger is always at least as fresh as Temporal. All writes are idempotent so
 * activity retries are safe. Features add their own tracked activities with
 * `trackedAttempt` and spread them into the bag in worker.ts.
 */
import { Context } from '@temporalio/activity';
import type { Pool } from 'pg';

import { createJobContext, type JobContext } from './log';
import { closeRun, markAttemptFinish, markAttemptStart, markRunStarted, purgeOld, type CloseOutcome } from './store';

export const LOG_RETENTION_DAYS = 30;
export const RUN_RETENTION_DAYS = 180;

export function createLedgerActivities(db: Pool, workerId: string) {
  /**
   * Wrap a job's work activity: records the attempt (attempt_no = Temporal's
   * activity attempt), gives the body a ctx.log bound to it, and closes the
   * attempt with the error message/stack/code on failure.
   */
  async function trackedAttempt<T>(runId: string, body: (ctx: JobContext) => Promise<T>): Promise<T> {
    const attemptNo = Context.current().info.attempt;
    await markAttemptStart(db, runId, attemptNo, workerId);
    const ctx = createJobContext(db, { runId, attemptNo });
    try {
      const result = await body(ctx);
      await markAttemptFinish(db, runId, attemptNo, { status: 'succeeded' });
      return result;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const cancelled = err.name === 'CancelledFailure';
      await ctx.log(cancelled ? 'warn' : 'error', err.message);
      await markAttemptFinish(db, runId, attemptNo, {
        status: cancelled ? 'cancelled' : 'failed',
        errorMessage: err.message,
        errorStack: err.stack ?? null,
        errorCode: (err as { code?: string }).code ?? err.name,
      });
      throw e;
    }
  }

  return {
    trackedAttempt,
    async markRunStarted(runId: string): Promise<boolean> {
      return markRunStarted(db, runId, (Context.current().info as { workflowExecution?: { runId?: string } }).workflowExecution?.runId);
    },
    async closeRun(o: CloseOutcome & { runId: string }): Promise<void> {
      await closeRun(db, o.runId, o);
    },
    async retentionSweep(): Promise<{ logs: number; runs: number }> {
      return purgeOld(db, LOG_RETENTION_DAYS, RUN_RETENTION_DAYS);
    },
    /** Demo job: logs, heartbeats while "working", optionally fails. */
    async jobsNoopWork(args: { runId: string; input: unknown }): Promise<{ ok: true; slept_ms: number }> {
      return trackedAttempt(args.runId, async (ctx) => {
        const input = (args.input ?? {}) as { sleepMs?: number; fail?: boolean };
        const sleepMs = Math.min(Math.max(input.sleepMs ?? 500, 0), 60_000);
        await ctx.log('info', 'noop job started', { sleepMs });
        const stepMs = 250;
        for (let waited = 0; waited < sleepMs; waited += stepMs) {
          Context.current().heartbeat(waited);
          await Context.current().sleep(Math.min(stepMs, sleepMs - waited));
        }
        if (input.fail) throw new Error('noop job asked to fail');
        await ctx.log('info', 'noop job finished');
        return { ok: true as const, slept_ms: sleepMs };
      });
    },
  };
}

export type LedgerActivities = Omit<ReturnType<typeof createLedgerActivities>, 'trackedAttempt'>;
