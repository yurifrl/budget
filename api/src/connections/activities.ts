/**
 * Connections activities (Temporal side; deep-imported by server/worker.ts).
 * `trackedAttempt` comes from the jobs ledger activities and is injected so
 * this feature never imports jobs internals.
 *
 * Failure taxonomy (Q17) lives in `toActivityFailure`: it maps AggregatorError
 * kinds and HTTP-ish errors onto retryable/non-retryable ApplicationFailures
 * whose `type` the workflow turns into the user-safe run message.
 */
import { ApplicationFailure, Context } from '@temporalio/activity';
import type { Pool } from 'pg';

import { hasOtherActiveRun, type JobContext } from '../jobs';
import { HttpError } from '../core/validate';
import { AggregatorError, USER_MESSAGES } from './errors';
import { enqueueConnectionSync } from './job';
import { CONNECTIONS_SYNC_JOB, syncSubjectKey, type SyncMode } from './jobspec';
import { keyAccessForConnection, reconcileKeyAccess, type KeyAccessProblem } from './keys';
import {
  getConnectionById,
  listSweepConnections,
  pruneConnectionEvents,
  setConnectionStatus,
  type ConnectionRow,
} from './store';
import { refreshConnection } from './sync';

/** Webhook dedupe ledger retention (connection_events, 0014). */
const EVENT_RETENTION_DAYS = 30;
/** Cap on a provider-requested pause (RateLimit-Reset) so a bad header can't park a run for hours. */
const MAX_RATE_LIMIT_DELAY_MS = 15 * 60_000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
const HEARTBEAT_EVERY_MS = 10_000;

/** First instant of next month (UTC): when a spent monthly quota resets. */
export function startOfNextMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Any failure → the ApplicationFailure the retry policy and workflow understand. */
export function toActivityFailure(err: unknown): Error {
  if (err instanceof ApplicationFailure) return err;
  if (err instanceof Error && err.name === 'CancelledFailure') return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof AggregatorError) {
    switch (err.kind) {
      case 'auth':
        return ApplicationFailure.create({ message: msg, type: 'ConnectionAuth', nonRetryable: true });
      case 'rate_limited':
        return ApplicationFailure.create({
          message: msg,
          type: 'RateLimited',
          nextRetryDelay: Math.min(err.retryAfterMs ?? DEFAULT_RATE_LIMIT_DELAY_MS, MAX_RATE_LIMIT_DELAY_MS),
        });
      case 'permanent':
        return ApplicationFailure.create({ message: msg, type: 'Permanent', nonRetryable: true });
      default:
        return ApplicationFailure.create({ message: msg, type: 'Transient' });
    }
  }
  if (err instanceof HttpError) {
    // 404: connection vanished; other 4xx: caller error — neither heals by retrying.
    if (err.status >= 400 && err.status < 500 && err.status !== 409) {
      return ApplicationFailure.create({ message: msg, type: 'Permanent', nonRetryable: true });
    }
  }
  return ApplicationFailure.create({ message: msg, type: 'Transient' });
}

/** The current activity context, or null outside an activity (unit tests). */
function activityContext(): Context | null {
  try {
    return Context.current();
  } catch {
    return null;
  }
}
const beat = (detail?: unknown): void => activityContext()?.heartbeat(detail);

type Tracked = <T>(runId: string, body: (ctx: JobContext) => Promise<T>) => Promise<T>;

export function createConnectionsActivities(db: Pool, trackedAttempt: Tracked) {
  /** Runs `fn` while heartbeating on a timer (the pull itself can take ~90s per account). */
  async function withHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => beat(), HEARTBEAT_EVERY_MS);
    try {
      return await fn();
    } finally {
      clearInterval(timer);
    }
  }

  return {
    /** The sync itself: item preflight, pull, all-or-nothing write, status bookkeeping. */
    async connectionsSyncWork(args: { runId: string; connectionId: string; mode: SyncMode }): Promise<Record<string, unknown>> {
      return trackedAttempt(args.runId, async (ctx) => {
        const row = await currentConnection(args.connectionId);
        if (!row) throw ApplicationFailure.create({ message: 'connection not found', type: 'Permanent', nonRetryable: true });
        if (row.status === 'disconnected') return { skipped: 'disconnected' };
        if (row.status === 'paused') {
          await ctx.log('warn', 'connection is paused: its key set may not be used; nothing synced');
          return { skipped: 'paused' };
        }
        const access = await keyAccessForConnection(db, row);
        if (!access.ok) {
          throw ApplicationFailure.create({ message: keyProblemMessage(access.problem, row.provider), type: 'Permanent', nonRetryable: true });
        }
        const { aggregator } = access;
        try {
          return await withHeartbeat(async () => {
            const state = await aggregator.getItemState(row.external_id);
            if (state.status === 'unauthorized') throw new AggregatorError('auth', 'item requires re-authentication');
            if (state.status === 'quota_exhausted') {
              await pauseForQuota(row);
              await ctx.log('warn', 'provider quota exhausted; sync paused until next month');
              return { skipped: 'quota_exhausted' };
            }
            beat('item-ok');
            const { transactions } = await refreshConnection({
              userId: row.user_id,
              connectionId: row.id,
              aggregator,
              ignoreWatermark: args.mode === 'reimport',
              onProgress: () => beat('account'),
              // Cancel before phase 2 commits: the throw rolls the transaction back.
              beforeCommit: () => activityContext()?.cancellationSignal.throwIfAborted(),
            });
            await setConnectionStatus(row.id, 'connected', null);
            await ctx.log('info', 'sync finished', { ...transactions });
            if (transactions.skipped_deleted + transactions.skipped_other_account + transactions.failed > 0) {
              await ctx.log('warn', 'some bank transactions were not imported', {
                skipped_deleted: transactions.skipped_deleted,
                skipped_other_account: transactions.skipped_other_account,
                skipped_accounts: transactions.skipped_accounts,
                failed: transactions.failed,
                failures: transactions.failures,
              });
            }
            return { ...transactions };
          });
        } catch (err) {
          const failure = toActivityFailure(err);
          if (failure instanceof ApplicationFailure && failure.type === 'ConnectionAuth') {
            await setConnectionStatus(row.id, 'unauthorized', USER_MESSAGES.auth);
          }
          throw failure;
        }
      });
    },

    /** Final-failure bookkeeping: transient/permanent exhaustion marks the connection 'error'. */
    async connectionsMarkFailed(args: { connectionId: string; failureType: string }): Promise<void> {
      if (args.failureType !== 'Transient' && args.failureType !== 'Permanent') return; // auth set in-activity; rate limit is not a hard failure
      const row = await getConnectionById(args.connectionId);
      if (!row || (row.status !== 'connected' && row.status !== 'error')) return;
      await setConnectionStatus(row.id, 'error', args.failureType === 'Transient' ? USER_MESSAGES.transient : USER_MESSAGES.permanent);
    },

    /** Reimport waits while a plain sync of the same connection is queued/running. */
    async connectionsOtherSyncActive(args: { runId: string; connectionId: string }): Promise<boolean> {
      return hasOtherActiveRun(db, CONNECTIONS_SYNC_JOB, syncSubjectKey(args.connectionId, 'sync'), args.runId);
    },

    /** Sweep step 1: prune the webhook ledger, list sweepable connections. */
    async connectionsSweepList(): Promise<Array<{ id: string }>> {
      await pruneConnectionEvents(new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 3600 * 1000));
      return (await listSweepConnections(new Date())).map((c) => ({ id: c.id }));
    },

    /** Sweep step 2 (rate-limited queue): one GET item; enqueue a sync only if the provider has newer data. */
    async connectionsSweepCheck(args: { connectionId: string }): Promise<'enqueued' | 'fresh' | 'skipped'> {
      const before = await getConnectionById(args.connectionId);
      const row = await currentConnection(args.connectionId);
      // 'paused' is skipped here: the key set may not be used, so not even the item is read.
      // An own-key connection in 'error' is retried here: it has no webhook to revive it.
      const ownError = row?.status === 'error' && row.key_source === 'own';
      if (!row || (row.status !== 'connected' && row.status !== 'quota_exhausted' && !ownError)) return 'skipped';
      // A quota pause restored by a resume may still be running.
      if (row.status === 'quota_exhausted' && row.next_poll_at != null && row.next_poll_at.getTime() > Date.now()) return 'skipped';
      const access = await keyAccessForConnection(db, row);
      if (!access.ok) return 'skipped';
      const { aggregator } = access;
      // Just resumed (its key set became usable again): sync now, whatever the watermark says.
      const resumed = before?.status === 'paused';
      try {
        const state = await aggregator.getItemState(row.external_id);
        if (state.status === 'unauthorized') {
          await setConnectionStatus(row.id, 'unauthorized', USER_MESSAGES.auth);
          return 'skipped';
        }
        if (state.status === 'quota_exhausted') {
          await pauseForQuota(row);
          return 'skipped';
        }
        const changed =
          row.last_synced_at == null ||
          state.lastUpdatedAt == null ||
          Date.parse(state.lastUpdatedAt) > row.last_synced_at.getTime();
        if (!changed && !resumed && row.status === 'connected') return 'fresh';
        await enqueueConnectionSync(db, row, 'sync', 'sweep');
        return 'enqueued';
      } catch (err) {
        throw toActivityFailure(err);
      }
    },
  };

  /**
   * The connection as it stands after its owner's pause state was brought up
   * to date: turning the shared-keys feature off (or removing own keys) pauses
   * it here, with nobody calling an endpoint, and turning it back on resumes it.
   */
  async function currentConnection(id: string): Promise<ConnectionRow | null> {
    const row = await getConnectionById(id);
    if (!row || row.status === 'disconnected') return row;
    await reconcileKeyAccess(db, row.user_id);
    return getConnectionById(id);
  }

  async function pauseForQuota(row: ConnectionRow): Promise<void> {
    await setConnectionStatus(row.id, 'quota_exhausted', USER_MESSAGES.quota_exhausted, startOfNextMonth(new Date()));
  }
}

export type ConnectionsActivities = ReturnType<typeof createConnectionsActivities>;

const keyProblemMessage = (problem: KeyAccessProblem, provider: string): string =>
  problem === 'not_configured'
    ? `provider ${provider} is not configured`
    : problem === 'secret_unavailable'
      ? `the stored ${provider} keys of this connection cannot be decrypted (CREDENTIALS_ENCRYPTION_KEY missing or changed)`
      : `the ${provider} key set of this connection may not be used`;
