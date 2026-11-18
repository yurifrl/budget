/**
 * Tests for server/connections/webhook.ts — signature verification,
 * replay idempotency, and trigger-only behavior.
 *
 * Route exercised IN-PROCESS via app.request() with httpOnError installed so
 * HttpError maps to its status. DB tests are gated on Postgres reachability +
 * migrated schema (0014) so `bun test` stays green without a live DB.
 * Fixtures self-clean (store.test.ts pattern).
 *
 * The provider is a registry seam (setAggregators) with a static shared
 * secret — the real adapter suites cover provider-specific header parsing;
 * this file covers the route's HTTP contract for any provider.
 *
 * Actions: sync events enqueue a coalesced connections_sync job (the handler
 * never calls the provider or runs the sync engine — last_synced_at is stamped
 * only by the engine and must stay untouched); status events update
 * connections.status; a transient failure answers 503 and un-records the event
 * so the provider's retry is applied.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';

import { setAggregators, type AggregatorEntry } from './registry';
import * as store from './store';
import { pool } from '../core/db';
import { httpOnError } from '../core/validate';

const SECRET = 'webhook-test-secret';
const PROVIDER = 'testprov';
const EXTERNAL_ITEM = 'webhook-test-item-1';

const entry = (configured: boolean): AggregatorEntry => ({
  create: () => ({
    environment: 'production',
    createConnectToken: async () => ({ token: 't', clientId: 'c', widgetUrl: 'https://w' }),
    listExternalAccounts: async () => [],
    fetchInstitution: async () => null,
    getItemState: async () => ({ status: 'connected' as const, lastUpdatedAt: null }),
    listTransactions: async () => ({ transactions: [], hasMore: false }),
    deleteConnection: async () => {},
    mapWebhookDelivery: (payload: unknown) => {
      const body = (typeof payload === 'object' && payload !== null ? payload : {}) as {
        eventId?: unknown;
        event?: unknown;
        itemId?: unknown;
      };
      if (typeof body.eventId !== 'string' || typeof body.event !== 'string') return null;
      const base = {
        eventId: body.eventId,
        event: body.event,
        externalItemId: typeof body.itemId === 'string' ? body.itemId : null,
        clientUserId: null,
        raw: payload,
      };
      if (body.event === 'item/updated') return { ...base, action: 'sync' as const };
      if (body.event === 'item/error') return { ...base, action: 'status' as const, status: 'error' as const };
      if (body.event === 'item/waiting_user_action') return { ...base, action: 'status' as const, status: 'unauthorized' as const };
      return { ...base, action: 'ignore' as const };
    },
    mapStatus: () => 'connected',
    verifyWebhookHeaders: (headers: Headers) =>
      (headers.get('x-test-signature') ?? headers.get('authorization') ?? '').trim() ===
      `Bearer ${SECRET}`,
  }),
  configured: () => configured,
});

let dbReady = true;
try {
  await pool.query('select 1');
  await pool.query("select to_regclass('public.connection_events')::text is not null");
} catch {
  dbReady = false;
}

const userId = crypto.randomUUID();

const app = new Hono();
app.onError(httpOnError);
app.route('/', (await import('./webhook')).default);

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request(`/webhook/${PROVIDER}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const payload = (eventId: string, itemId: string | null = EXTERNAL_ITEM, event = 'item/updated') => ({
  event,
  eventId,
  ...(itemId == null ? {} : { itemId }),
});

const authed = { 'x-test-signature': `Bearer ${SECRET}` };

beforeAll(async () => {
  setAggregators({ [PROVIDER]: entry(true) });
  if (!dbReady) return;
  await pool.query('DELETE FROM public.budgets WHERE id = $1', [crypto.randomUUID()]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status)
     VALUES ($1, $2, 'connections-webhook@syscd.local', 'user', 'active')`,
    [userId, userId],
  );
  await store.upsertConnection({
    userId,
    provider: PROVIDER,
    externalId: EXTERNAL_ITEM,
    status: 'connected',
    environment: 'production',
  });
});

afterAll(async () => {
  setAggregators(null);
  delete process.env.WEBHOOK_TEST_SECRET;
  if (!dbReady) return;
  await store
    .getConnectionByUser(userId, (await store.listConnectionsByUser(userId))[0]?.id ?? '')
    .catch(() => null);
  await pool.query("DELETE FROM public.connection_events WHERE provider = 'testprov'");
  await pool.query("DELETE FROM jobs.job_runs WHERE tenant_id = $1", [userId]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
});

describe('connections webhook auth', () => {
  test('unknown provider → 404', async () => {
    const res = await app.request('/webhook/nosuchprovider', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  test('unconfigured provider → 503', async () => {
    setAggregators({ [PROVIDER]: entry(false) });
    try {
      const res = await post(payload('wh-test-unconf'), authed);
      expect(res.status).toBe(503);
    } finally {
      setAggregators({ [PROVIDER]: entry(true) });
    }
  });

  test('missing signature header → 401', async () => {
    const res = await post(payload('wh-test-noauth'));
    expect(res.status).toBe(401);
  });

  test('wrong secret header → 401', async () => {
    const res = await post(payload('wh-test-bad'), { 'x-test-signature': 'Bearer nope' });
    expect(res.status).toBe(401);
  });
});

describe('connections webhook handling', () => {
  test.skipIf(!dbReady)('malformed bodies → 400', async () => {
    const badJson = await post('{not json', authed);
    expect(badJson.status).toBe(400);

    const notAnEvent = await post({ hello: 'world' }, authed);
    expect(notAnEvent.status).toBe(400);
  });

  const runsFor = async (connectionId: string) =>
    (
      await pool.query<{ id: string; status: string; tenant_id: string }>(
        "select id, status, tenant_id from jobs.job_runs where job_type = 'connections_sync' and subject_key = $1 order by created_at",
        [connectionId],
      )
    ).rows;

  test.skipIf(!dbReady)('sync event: 200, ledger row, ONE coalesced queued job, engine NOT run', async () => {
    const row = (await store.listConnectionsByUser(userId)).find((r) => r.external_id === EXTERNAL_ITEM)!;
    expect(row.last_synced_at).toBeNull();

    const eventId = 'wh-test-first-delivery';
    const res = await post(payload(eventId), authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    // A second, distinct event while the first run is still queued joins it.
    expect((await post(payload('wh-test-second-delivery'), authed)).status).toBe(200);

    const runs = await runsFor(row.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'queued', tenant_id: userId });

    const fresh = (await store.listConnectionsByUser(userId)).find((r) => r.id === row.id)!;
    expect(fresh.last_synced_at).toBeNull();
    const ledger = await pool.query<{ n: string }>(
      'select count(*)::text as n from public.connection_events where event_id = $1',
      [eventId],
    );
    expect(ledger.rows[0]?.n).toBe('1');
  });

  test.skipIf(!dbReady)('status events update connections.status with a user-safe message', async () => {
    const row = (await store.listConnectionsByUser(userId)).find((r) => r.external_id === EXTERNAL_ITEM)!;
    expect((await post(payload('wh-test-waiting', EXTERNAL_ITEM, 'item/waiting_user_action'), authed)).status).toBe(200);
    let fresh = (await store.getConnectionByUser(userId, row.id))!;
    expect(fresh.status).toBe('unauthorized');
    expect(fresh.status_message).toBe('Reconnect your bank');

    expect((await post(payload('wh-test-error', EXTERNAL_ITEM, 'item/error'), authed)).status).toBe(200);
    fresh = (await store.getConnectionByUser(userId, row.id))!;
    expect(fresh.status).toBe('error');
    await store.setConnectionStatus(row.id, 'connected', null);
  });

  test.skipIf(!dbReady)('transient failure: 503 and the event is un-recorded so the retry applies', async () => {
    const real = pool.query.bind(pool);
    const spy = spyOn(pool, 'query').mockImplementation(((text: unknown, ...rest: unknown[]) => {
      if (typeof text === 'string' && text.includes('jobs.job_runs')) return Promise.reject(new Error('db down'));
      return (real as (...a: unknown[]) => unknown)(text, ...rest);
    }) as typeof pool.query);
    let res: Response;
    try {
      res = await post(payload('wh-test-transient', EXTERNAL_ITEM, 'item/updated'), authed);
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(503);
    const left = await pool.query('select 1 from public.connection_events where event_id = $1', ['wh-test-transient']);
    expect(left.rowCount).toBe(0);
    // The provider's retry succeeds.
    expect((await post(payload('wh-test-transient', EXTERNAL_ITEM, 'item/updated'), authed)).status).toBe(200);
  });

  test.skipIf(!dbReady)('replayed eventId → 200 no-op, no duplicate ledger row', async () => {
    const eventId = 'wh-test-replay';
    const first = await post(payload(eventId), authed);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });

    const second = await post(payload(eventId), authed);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, replay: true });

    const ledger = await pool.query<{ n: string }>(
      'select count(*)::text as n from public.connection_events where event_id = $1',
      [eventId],
    );
    expect(ledger.rows[0]?.n).toBe('1');
  });

  test.skipIf(!dbReady)('unknown itemId accepted but unactionable (no crash)', async () => {
    const res = await post(payload('wh-test-unknown', 'no-such-upstream-item'), authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });
});
