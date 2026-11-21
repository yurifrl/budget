import { describe, expect, test } from 'bun:test';

import { deriveSyncState, type SyncState } from './sync-state';

describe('deriveSyncState (table)', () => {
  const cases: Array<[string, Parameters<typeof deriveSyncState>[0], SyncState]> = [
    ['healthy idle', { status: 'connected', activeRun: null, schedulerDegraded: false }, 'connected'],
    ['running', { status: 'connected', activeRun: 'running', schedulerDegraded: false }, 'syncing'],
    ['queued, scheduler up', { status: 'connected', activeRun: 'queued', schedulerDegraded: false }, 'queued'],
    ['queued, scheduler down', { status: 'connected', activeRun: 'queued', schedulerDegraded: true }, 'queued_offline'],
    ['running beats degraded flag', { status: 'connected', activeRun: 'running', schedulerDegraded: true }, 'syncing'],
    ['unauthorized', { status: 'unauthorized', activeRun: null, schedulerDegraded: false }, 'reconnect'],
    ['quota', { status: 'quota_exhausted', activeRun: null, schedulerDegraded: false }, 'quota'],
    ['error', { status: 'error', activeRun: null, schedulerDegraded: false }, 'error'],
    ['paused', { status: 'paused', activeRun: null, schedulerDegraded: false }, 'paused'],
    ['paused wins over a queued run (it will skip)', { status: 'paused', activeRun: 'queued', schedulerDegraded: false }, 'paused'],
    ['disconnected wins', { status: 'disconnected', activeRun: 'queued', schedulerDegraded: true }, 'disconnected'],
    ['queued on a broken connection still shows queued', { status: 'error', activeRun: 'queued', schedulerDegraded: false }, 'queued'],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => expect(deriveSyncState(input)).toBe(expected));
  }
});
