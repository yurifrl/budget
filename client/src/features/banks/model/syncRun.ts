/**
 * Background bank-sync runs, client side. A sync request returns a queued run
 * immediately; these pure helpers poll the sync-status endpoint until that run
 * is terminal (or the scheduler is offline) and turn the outcome into the
 * report / error text the screens show. No React, no network client — the
 * caller injects `fetchStatus`.
 */

import type { ConnectionJson, SyncCountsJson, SyncRunJson, SyncState, SyncStatusJson } from '@/budget/data/connections';

import { t } from '../i18n';
import { storedServerMessage } from './serverMessage';

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

/** Report (green) or error (red) text for a finished request. `label` is "Sync" or "Re-import". */
export function describeSyncOutcome(
  outcome: SyncRunOutcome,
  label: 'Sync' | 'Re-import',
): { kind: 'report' | 'error'; text: string } {
  // One whole sentence per label: word order and verbs differ between languages.
  const sync = label === 'Sync';
  if (outcome.kind === 'offline') {
    return { kind: 'report', text: sync ? t('syncRun.sync.offline') : t('syncRun.reimport.offline') };
  }
  if (outcome.kind === 'timeout') {
    return { kind: 'report', text: sync ? t('syncRun.sync.timeout') : t('syncRun.reimport.timeout') };
  }
  const run = outcome.run;
  if (!run) return { kind: 'report', text: sync ? t('syncRun.sync.finished') : t('syncRun.reimport.finished') };
  // `user_message` is the server's stored sentence: translated by its code when there is one.
  const userMessage = storedServerMessage(run.user_message, run.user_message_code);
  if (run.status === 'failed') {
    return { kind: 'error', text: userMessage ?? (sync ? t('syncRun.sync.failed') : t('syncRun.reimport.failed')) };
  }
  if (run.status === 'cancelled') {
    return { kind: 'report', text: sync ? t('syncRun.sync.cancelled') : t('syncRun.reimport.cancelled') };
  }
  // Succeeded: a notice (e.g. quota paused) wins over counts.
  if (userMessage) return { kind: 'report', text: userMessage };
  const { added = 0, updated = 0, deleted = 0 }: Partial<SyncCountsJson> = run.result ?? {};
  const counts = { added, updated, deleted };
  if (added + updated + deleted === 0) {
    return { kind: 'report', text: sync ? t('syncRun.sync.completeNothing') : t('syncRun.reimport.completeNothing') };
  }
  return { kind: 'report', text: sync ? t('syncRun.sync.completeCounts', counts) : t('syncRun.reimport.completeCounts', counts) };
}

export type StatusTone = 'ok' | 'warn' | 'bad' | 'off';

/** Pill label + tone for the derived sync state (the one status source for list + settings). */
export function syncStateView(state: SyncState): { label: string; tone: StatusTone } {
  switch (state) {
    case 'connected':
      return { label: t('status.synced'), tone: 'ok' };
    case 'syncing':
      return { label: t('status.syncing'), tone: 'ok' };
    case 'queued':
      return { label: t('status.queued'), tone: 'warn' };
    case 'queued_offline':
      return { label: t('status.queuedOffline'), tone: 'warn' };
    case 'reconnect':
      return { label: t('status.reconnect'), tone: 'warn' };
    case 'quota':
      return { label: t('status.limitReached'), tone: 'warn' };
    case 'paused':
      return { label: t('status.paused'), tone: 'warn' };
    case 'error':
      return { label: t('status.error'), tone: 'bad' };
    default:
      return { label: t('status.disconnected'), tone: 'off' };
  }
}

/** Banner text when the background scheduler is unreachable; null when healthy. */
export function schedulerBanner(status: Pick<SyncStatusJson, 'scheduler_degraded'> | undefined): string | null {
  return status?.scheduler_degraded
    ? t('syncRun.schedulerBanner')
    : null;
}

/** Whether a polling screen should refresh fast: something is queued or running. */
export function hasActiveRun(status: SyncStatusJson | undefined): boolean {
  return status?.connections.some((c) => c.active_run != null) ?? false;
}

/** Sync is allowed unless the connection needs the user (reauth/disconnected). Quota/error still try. */
export const canRequestSync = (status: ConnectionJson['status']): boolean => status === 'connected' || status === 'error' || status === 'quota_exhausted';
