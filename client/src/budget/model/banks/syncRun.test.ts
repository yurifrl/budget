import { describe, expect, test } from 'bun:test';

import type { ConnectionSyncStatusJson, SyncRunJson, SyncState, SyncStatusJson } from '../../data/connections';
import { awaitSyncRun, describeSyncOutcome, schedulerBanner, syncStateView } from './syncRun';

const run = (over: Partial<SyncRunJson> = {}): SyncRunJson => ({
  id: 'r1',
  status: 'queued',
  mode: 'sync',
  created_at: '2026-01-01T00:00:00Z',
  finished_at: null,
  user_message: null,
  result: null,
  ...over,
});

const entry = (over: Partial<ConnectionSyncStatusJson>): ConnectionSyncStatusJson => ({
  id: 'c1',
  institution: 'Bank',
  status: 'connected',
  status_message: null,
  last_synced_at: null,
  state: 'connected',
  active_run: null,
  last_run: null,
  ...over,
});

const status = (...connections: ConnectionSyncStatusJson[]): SyncStatusJson => ({ scheduler_degraded: false, connections });

describe('awaitSyncRun', () => {
  const fast = { sleep: async () => {}, intervalMs: 0 };

  test('polls until the run leaves the active slot, then returns it', async () => {
    const seq = [
      status(entry({ state: 'queued', active_run: run() })),
      status(entry({ state: 'syncing', active_run: run({ status: 'running' }) })),
      status(entry({ last_run: run({ status: 'succeeded', result: { added: 2 } }) })),
    ];
    let i = 0;
    const out = await awaitSyncRun(async () => seq[i++]!, 'c1', 'r1', fast);
    expect(out).toEqual({ kind: 'done', run: run({ status: 'succeeded', result: { added: 2 } }) });
    expect(i).toBe(3);
  });

  test('stops early when the scheduler is offline', async () => {
    const out = await awaitSyncRun(async () => status(entry({ state: 'queued_offline', active_run: run() })), 'c1', 'r1', fast);
    expect(out).toEqual({ kind: 'offline' });
  });

  test('times out on a run that never finishes', async () => {
    let t = 0;
    const out = await awaitSyncRun(async () => status(entry({ state: 'syncing', active_run: run({ status: 'running' }) })), 'c1', 'r1', {
      ...fast,
      timeoutMs: 100,
      now: () => (t += 60),
    });
    expect(out).toEqual({ kind: 'timeout' });
  });

  test('a vanished connection ends the wait', async () => {
    expect(await awaitSyncRun(async () => status(), 'c1', 'r1', fast)).toEqual({ kind: 'done', run: null });
  });
});

describe('describeSyncOutcome (table)', () => {
  const done = (r: SyncRunJson) => ({ kind: 'done' as const, run: r });
  const cases: Array<[string, Parameters<typeof describeSyncOutcome>[0], string, string]> = [
    ['nothing new', done(run({ status: 'succeeded', result: { added: 0 } })), 'report', 'Sync complete — nothing new'],
    ['counts', done(run({ status: 'succeeded', result: { added: 2, updated: 1, deleted: 1 } })), 'report', 'Sync complete — 2 added · 1 updated · 1 removed'],
    ['quota notice wins', done(run({ status: 'succeeded', user_message: 'Bank limits reached — data resumes next month', result: { skipped: 'quota_exhausted' } })), 'report', 'Bank limits reached — data resumes next month'],
    ['failure shows the user message', done(run({ status: 'failed', user_message: 'Reconnect your bank' })), 'error', 'Reconnect your bank'],
    ['failure without message', done(run({ status: 'failed' })), 'error', 'Sync failed. Try again later.'],
    ['offline', { kind: 'offline' }, 'report', 'Background sync is offline — sync queued, it will run when the scheduler recovers.'],
    ['timeout', { kind: 'timeout' }, 'report', 'Sync is still running in the background.'],
  ];
  for (const [name, outcome, kind, text] of cases) {
    test(name, () => expect(describeSyncOutcome(outcome, 'Sync')).toEqual({ kind: kind as 'report' | 'error', text }));
  }
  test('re-import label', () => {
    expect(describeSyncOutcome(done(run({ status: 'succeeded', mode: 'reimport', result: {} })), 'Re-import').text).toBe('Re-import complete — nothing new');
  });
});

describe('view helpers', () => {
  test('every state has a pill', () => {
    const states: SyncState[] = ['connected', 'syncing', 'queued', 'queued_offline', 'reconnect', 'quota', 'error', 'disconnected'];
    expect(states.map((s) => syncStateView(s).label)).toEqual([
      'Synced', 'Syncing…', 'Queued', 'Queued · scheduler offline', 'Reconnect', 'Bank limit reached', 'Sync error', 'Disconnected',
    ]);
  });
  test('banner only when degraded', () => {
    expect(schedulerBanner({ scheduler_degraded: false })).toBeNull();
    expect(schedulerBanner(undefined)).toBeNull();
    expect(schedulerBanner({ scheduler_degraded: true })).toContain('offline');
  });
});
