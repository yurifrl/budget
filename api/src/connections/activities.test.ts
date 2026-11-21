/**
 * Connections job activities: failure taxonomy → retry semantics, status
 * bookkeeping (unauthorized / quota_exhausted / connected / error) and the
 * sweep's "only if the provider has newer data" rule. DB-backed parts skip
 * without Postgres; the activity bodies run outside Temporal (heartbeat and
 * cancellation helpers no-op without an activity context).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ApplicationFailure } from '@temporalio/activity';

import { pool } from '../core/db';
import { HttpError } from '../core/validate';
import { createConnectionsActivities, startOfNextMonth, toActivityFailure } from './activities';
import { AggregatorError } from './errors';
import { setAggregators, type AggregatorEntry } from './registry';
import * as store from './store';
import type { BankAggregator, ItemState } from './types';
import { userMessageForFailure } from './workflows';

describe('toActivityFailure (table)', () => {
  const cases: Array<[string, unknown, { type: string; nonRetryable: boolean; delay?: unknown }]> = [
    ['auth', new AggregatorError('auth', 'x'), { type: 'ConnectionAuth', nonRetryable: true }],
    ['permanent', new AggregatorError('permanent', 'x'), { type: 'Permanent', nonRetryable: true }],
    ['transient', new AggregatorError('transient', 'x'), { type: 'Transient', nonRetryable: false }],
    ['rate limit honors RateLimit-Reset', new AggregatorError('rate_limited', 'x', 20_000), { type: 'RateLimited', nonRetryable: false, delay: 20_000 }],
    ['rate limit default pause', new AggregatorError('rate_limited', 'x'), { type: 'RateLimited', nonRetryable: false, delay: 60_000 }],
    ['rate limit capped at 15m', new AggregatorError('rate_limited', 'x', 99 * 3_600_000), { type: 'RateLimited', nonRetryable: false, delay: 900_000 }],
    ['http 404 (connection gone)', new HttpError(404, 'nope'), { type: 'Permanent', nonRetryable: true }],
    ['http 504 timeout', new HttpError(504, 'timed out'), { type: 'Transient', nonRetryable: false }],
    ['http 409 race', new HttpError(409, 'raced'), { type: 'Transient', nonRetryable: false }],
    ['unknown error', new Error('driver blew up'), { type: 'Transient', nonRetryable: false }],
  ];
  for (const [name, err, want] of cases) {
    test(name, () => {
      const f = toActivityFailure(err) as ApplicationFailure;
      expect(f).toBeInstanceOf(ApplicationFailure);
      expect(f.type).toBe(want.type);
      expect(f.nonRetryable).toBe(want.nonRetryable);
      if (want.delay !== undefined) expect(f.nextRetryDelay).toBe(want.delay as number);
    });
  }
});

describe('user messages never leak raw errors', () => {
  test('kind → fixed text', () => {
    const wrap = (type: string) => Object.assign(new Error('wrapped'), { cause: ApplicationFailure.create({ message: 'secret stack', type }) });
    // userMessageForFailure only trusts ActivityFailure causes; anything else is the generic message.
    expect(userMessageForFailure(wrap('ConnectionAuth'))).toBe("Couldn't sync with the bank. Try again later.");
    expect(userMessageForFailure(new Error('db password=hunter2'))).not.toContain('hunter2');
  });
});

test('startOfNextMonth rolls the year', () => {
  expect(startOfNextMonth(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  expect(startOfNextMonth(new Date('2026-03-10T00:00:00Z')).toISOString()).toBe('2026-04-01T00:00:00.000Z');
});

// ---- DB-backed activity behaviour ----------------------------------------

let dbReady = true;
try {
  await pool.query('select 1');
  await pool.query("select to_regclass('jobs.job_runs')::text is not null");
} catch {
  dbReady = false;
}

const PROVIDER = 'actprov';
const userId = crypto.randomUUID();
let itemState: ItemState | Error = { status: 'connected', lastUpdatedAt: null };
let listCalls = 0;

const entry: AggregatorEntry = {
  configured: () => true,
  create: () =>
    ({
      environment: 'production',
      verifyCredentials: async () => true,
      hasItem: async () => true,
      createConnectToken: async () => ({ token: 't', clientId: null, widgetUrl: null }),
      listExternalAccounts: async () => [],
      listTransactions: async () => {
        listCalls++;
        return { transactions: [], hasMore: false };
      },
      deleteConnection: async () => {},
      fetchInstitution: async () => null,
      getItemState: async () => {
        if (itemState instanceof Error) throw itemState;
        return itemState;
      },
      mapWebhookDelivery: () => null,
      mapStatus: () => 'connected',
      verifyWebhookHeaders: () => true,
    }) satisfies BankAggregator,
};

const acts = createConnectionsActivities(pool, async (_runId, body) => body({ log: async () => {} } as never));
let n = 0;
const newConn = async (status = 'connected') =>
  store.upsertConnection({ userId, provider: PROVIDER, externalId: `act-item-${++n}-${Date.now()}`, status, environment: 'production' });
const reload = async (id: string) => (await store.getConnectionById(id))!;

beforeAll(async () => {
  if (!dbReady) return;
  setAggregators({ [PROVIDER]: entry });
  await pool.query(
    `insert into public.users (id, google_sub, email, role, status) values ($1, $2, 'connections-activities@syscd.local', 'user', 'active')`,
    [userId, userId],
  );
  // The connections below run on the shared keys; this user may use them.
  await pool.query(`insert into public.feature_overrides (feature_key, user_id, value) values ('shared-pluggy-key', $1, true)`, [userId]);
});
afterAll(async () => {
  setAggregators(null);
  if (!dbReady) return;
  await pool.query('delete from jobs.job_runs where tenant_id = $1', [userId]);
  await pool.query('delete from public.users where id = $1', [userId]);
});

describe('connectionsSyncWork', () => {
  test.skipIf(!dbReady)('success → connected, message cleared, watermark stamped', async () => {
    itemState = { status: 'connected', lastUpdatedAt: null };
    const c = await newConn('error');
    await store.setConnectionStatus(c.id, 'error', 'old failure');
    const result = await acts.connectionsSyncWork({ runId: crypto.randomUUID(), connectionId: c.id, mode: 'sync' });
    expect(result).toMatchObject({ added: 0 });
    const after = await reload(c.id);
    expect(after).toMatchObject({ status: 'connected', status_message: null });
    expect(after.last_synced_at).not.toBeNull();
  });

  test.skipIf(!dbReady)('revoked consent (item LOGIN_ERROR) → non-retryable auth failure + status unauthorized', async () => {
    itemState = { status: 'unauthorized', lastUpdatedAt: null };
    const c = await newConn();
    const err = (await acts.connectionsSyncWork({ runId: crypto.randomUUID(), connectionId: c.id, mode: 'sync' }).catch((e) => e)) as ApplicationFailure;
    expect(err).toMatchObject({ type: 'ConnectionAuth', nonRetryable: true });
    expect(await reload(c.id)).toMatchObject({ status: 'unauthorized', status_message: 'Reconnect your bank' });
  });

  test.skipIf(!dbReady)('provider 401 mid-pull → same auth handling', async () => {
    itemState = new AggregatorError('auth', 'consent expired');
    const c = await newConn();
    const err = (await acts.connectionsSyncWork({ runId: crypto.randomUUID(), connectionId: c.id, mode: 'sync' }).catch((e) => e)) as ApplicationFailure;
    expect(err.type).toBe('ConnectionAuth');
    expect((await reload(c.id)).status).toBe('unauthorized');
  });

  test.skipIf(!dbReady)('quota (PARTIAL_SUCCESS/423) → skipped, quota_exhausted until next month, no pull', async () => {
    itemState = { status: 'quota_exhausted', lastUpdatedAt: null };
    const c = await newConn();
    listCalls = 0;
    const result = await acts.connectionsSyncWork({ runId: crypto.randomUUID(), connectionId: c.id, mode: 'sync' });
    expect(result).toEqual({ skipped: 'quota_exhausted' });
    const after = await reload(c.id);
    expect(after).toMatchObject({ status: 'quota_exhausted', status_message: 'Bank limits reached — data resumes next month' });
    expect(after.next_poll_at!.toISOString()).toBe(startOfNextMonth(new Date()).toISOString());
    expect(listCalls).toBe(0);
  });

  test.skipIf(!dbReady)('429 → retryable RateLimited with the provider delay; status untouched', async () => {
    itemState = new AggregatorError('rate_limited', 'slow', 30_000);
    const c = await newConn();
    const err = (await acts.connectionsSyncWork({ runId: crypto.randomUUID(), connectionId: c.id, mode: 'sync' }).catch((e) => e)) as ApplicationFailure;
    expect(err).toMatchObject({ type: 'RateLimited', nonRetryable: false, nextRetryDelay: 30_000 });
    expect((await reload(c.id)).status).toBe('connected');
  });

  test.skipIf(!dbReady)('disconnected connection is skipped', async () => {
    const c = await newConn();
    await store.markDisconnected(c.id);
    expect(await acts.connectionsSyncWork({ runId: crypto.randomUUID(), connectionId: c.id, mode: 'sync' })).toEqual({ skipped: 'disconnected' });
  });
});

describe('connectionsMarkFailed', () => {
  test.skipIf(!dbReady)('final transient/permanent failure → status error + sanitized message; auth/rate-limit/unauthorized untouched', async () => {
    const c = await newConn();
    await acts.connectionsMarkFailed({ connectionId: c.id, failureType: 'RateLimited' });
    expect((await reload(c.id)).status).toBe('connected');
    await acts.connectionsMarkFailed({ connectionId: c.id, failureType: 'Transient' });
    expect(await reload(c.id)).toMatchObject({ status: 'error', status_message: "Couldn't reach the bank. We will try again later." });

    const u = await newConn('unauthorized');
    await acts.connectionsMarkFailed({ connectionId: u.id, failureType: 'Transient' });
    expect((await reload(u.id)).status).toBe('unauthorized');
  });
});

describe('sweep', () => {
  const queuedFor = async (id: string) =>
    (await pool.query("select count(*)::int as n from jobs.job_runs where job_type = 'connections_sync' and subject_key = $1 and status = 'queued'", [id])).rows[0].n as number;

  test.skipIf(!dbReady)('enqueues only when the provider has newer data than last_synced_at', async () => {
    const c = await newConn();
    await pool.query("update public.connections set last_synced_at = '2026-01-10T00:00:00Z' where id = $1", [c.id]);

    itemState = { status: 'connected', lastUpdatedAt: '2026-01-09T00:00:00Z' };
    expect(await acts.connectionsSweepCheck({ connectionId: c.id })).toBe('fresh');
    expect(await queuedFor(c.id)).toBe(0);

    itemState = { status: 'connected', lastUpdatedAt: '2026-01-11T00:00:00Z' };
    expect(await acts.connectionsSweepCheck({ connectionId: c.id })).toBe('enqueued');
    expect(await acts.connectionsSweepCheck({ connectionId: c.id })).toBe('enqueued'); // coalesced
    expect(await queuedFor(c.id)).toBe(1);
  });

  test.skipIf(!dbReady)('skips unauthorized rows, flips status on revoked consent / quota', async () => {
    const u = await newConn('unauthorized');
    expect(await acts.connectionsSweepCheck({ connectionId: u.id })).toBe('skipped');

    const c = await newConn();
    itemState = { status: 'unauthorized', lastUpdatedAt: null };
    expect(await acts.connectionsSweepCheck({ connectionId: c.id })).toBe('skipped');
    expect((await reload(c.id)).status).toBe('unauthorized');

    const q = await newConn();
    itemState = { status: 'quota_exhausted', lastUpdatedAt: null };
    await acts.connectionsSweepCheck({ connectionId: q.id });
    expect((await reload(q.id)).status).toBe('quota_exhausted');
    expect(await queuedFor(q.id)).toBe(0);
  });

  test.skipIf(!dbReady)('an expired quota pause is resumed by the sweep', async () => {
    const q = await newConn();
    await store.setConnectionStatus(q.id, 'quota_exhausted', 'x', new Date(Date.now() - 1000));
    itemState = { status: 'connected', lastUpdatedAt: '2000-01-01T00:00:00Z' };
    expect((await acts.connectionsSweepList()).map((r) => r.id)).toContain(q.id);
    expect(await acts.connectionsSweepCheck({ connectionId: q.id })).toBe('enqueued');
  });
});

describe('reimport waits behind a plain sync', () => {
  test.skipIf(!dbReady)('connectionsOtherSyncActive sees a queued plain sync, not its own run', async () => {
    const c = await newConn();
    const { enqueueConnectionSync } = await import('./job');
    const sync = await enqueueConnectionSync(pool, c, 'sync', 'test');
    const re = await enqueueConnectionSync(pool, c, 'reimport', 'test');
    expect(re.run.id).not.toBe(sync.run.id);
    expect(await acts.connectionsOtherSyncActive({ runId: re.run.id, connectionId: c.id })).toBe(true);
    expect(await acts.connectionsOtherSyncActive({ runId: sync.run.id, connectionId: c.id })).toBe(false);
  });
});
