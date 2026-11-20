/**
 * Background bank-sync runs, client side. A sync request returns a queued run
 * immediately; these pure helpers poll the sync-status endpoint until that run
 * is terminal (or the scheduler is offline) and turn the outcome into the
 * report / error text the screens show. No React, no network client — the
 * caller injects `fetchStatus`.
 */

import type { ConnectionJson, SyncCountsJson, SyncRunJson, SyncState, SyncStatusJson } from '@/budget/data/connections';

export type SyncRunOutcome =
  | { kind: 'done'; run: SyncRunJson | null }
  | { kind: 'offline' }
  | { kind: 'timeout' };

export interface AwaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function awaitSyncRun(
  fetchStatus: () => Promise<SyncStatusJson>,
  connectionId: string,
  runId: string,
  opts: AwaitOptions = {},
): Promise<SyncRunOutcome> {
  const interval = opts.intervalMs ?? 1500;
  const timeout = opts.timeoutMs ?? 5 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeout;
  for (;;) {
    const entry = (await fetchStatus()).connections.find((c) => c.id === connectionId);
    if (!entry) return { kind: 'done', run: null };
    if (entry.active_run?.id === runId) {
      if (entry.state === 'queued_offline') return { kind: 'offline' };
    } else {
      const run = entry.last_run?.id === runId ? entry.last_run : null;
      return { kind: 'done', run };
    }
    if (now() >= deadline) return { kind: 'timeout' };
    await sleep(interval);
  }
}

const countsLine = (c: Partial<SyncCountsJson>): string => {
  const { added = 0, updated = 0, deleted = 0 } = c;
  return added + updated + deleted === 0 ? 'nothing new' : `${added} added · ${updated} updated · ${deleted} removed`;
};

/** Report (green) or error (red) text for a finished request. `label` is "Sync" or "Re-import". */
export function describeSyncOutcome(
  outcome: SyncRunOutcome,
  label: 'Sync' | 'Re-import',
): { kind: 'report' | 'error'; text: string } {
  if (outcome.kind === 'offline') {
    return { kind: 'report', text: `Background sync is offline — ${label.toLowerCase()} queued, it will run when the scheduler recovers.` };
  }
  if (outcome.kind === 'timeout') {
    return { kind: 'report', text: `${label} is still running in the background.` };
  }
  const run = outcome.run;
  if (!run) return { kind: 'report', text: `${label} finished.` };
  if (run.status === 'failed') return { kind: 'error', text: run.user_message ?? `${label} failed. Try again later.` };
  if (run.status === 'cancelled') return { kind: 'report', text: `${label} was cancelled.` };
  // Succeeded: a notice (e.g. quota paused) wins over counts.
  if (run.user_message) return { kind: 'report', text: run.user_message };
  return { kind: 'report', text: `${label} complete — ${countsLine(run.result ?? {})}` };
}

export type StatusTone = 'ok' | 'warn' | 'bad' | 'off';

/** Pill label + tone for the derived sync state (the one status source for list + settings). */
export function syncStateView(state: SyncState): { label: string; tone: StatusTone } {
  switch (state) {
    case 'connected':
      return { label: 'Synced', tone: 'ok' };
    case 'syncing':
      return { label: 'Syncing…', tone: 'ok' };
    case 'queued':
      return { label: 'Queued', tone: 'warn' };
    case 'queued_offline':
      return { label: 'Queued · scheduler offline', tone: 'warn' };
    case 'reconnect':
      return { label: 'Reconnect', tone: 'warn' };
    case 'quota':
      return { label: 'Bank limit reached', tone: 'warn' };
    case 'paused':
      return { label: 'Paused · needs your keys', tone: 'warn' };
    case 'error':
      return { label: 'Sync error', tone: 'bad' };
    default:
      return { label: 'Disconnected', tone: 'off' };
  }
}

/** Banner text when the background scheduler is unreachable; null when healthy. */
export function schedulerBanner(status: Pick<SyncStatusJson, 'scheduler_degraded'> | undefined): string | null {
  return status?.scheduler_degraded
    ? 'Background sync is offline. Syncs are queued and will run when it recovers — nothing is lost.'
    : null;
}

/** Whether a polling screen should refresh fast: something is queued or running. */
export function hasActiveRun(status: SyncStatusJson | undefined): boolean {
  return status?.connections.some((c) => c.active_run != null) ?? false;
}

/** Sync is allowed unless the connection needs the user (reauth/disconnected). Quota/error still try. */
export const canRequestSync = (status: ConnectionJson['status']): boolean => status === 'connected' || status === 'error' || status === 'quota_exhausted';
