/**
 * Tests for server/connections/store.ts — connection persistence
 * (db/migrations/0014_connections.sql). DB tests are gated on Postgres
 * reachability + migrated schema (server/user/store.test.ts pattern) so
 * `bun test` stays green without a live DB. Fixtures self-clean: deleting the
 * test users cascades connections/connection_events, and the test budget is
 * deleted directly.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { HttpError } from '../core/validate';
import * as store from './store';

// DB-backed behavior: provisioned rows must resolve against the same pool the
// server uses. Probe reachability + schema; skip DB tests when unavailable.
let dbReady = true;
try {
  await pool.query('SELECT 1');
  const schema = await pool.query<{ t: string | null }>(
    "select to_regclass('public.connections')::text as t",
  );
  dbReady = schema.rows[0]?.t != null;
} catch {
  dbReady = false;
}

const userA = crypto.randomUUID();
const userB = crypto.randomUUID();
const budgetA = crypto.randomUUID();

const conn = (overrides: Partial<Parameters<typeof store.upsertConnection>[0]> = {}) => ({
  userId: userA,
  provider: 'testprovider',
  externalId: 'up-item-store-1',
  clientUserId: 'cu-1',
  status: 'connected',
  environment: 'production',
  ...overrides,
});

beforeAll(async () => {
  if (!dbReady) return;
  await pool.query('DELETE FROM public.budgets WHERE name = $1', ['connections-store-test']);
  await pool.query('DELETE FROM public.users WHERE email IN ($1, $2)', [
    'connections-store-a@syscd.local',
    'connections-store-b@syscd.local',
  ]);
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status)
     VALUES ($1, $2, $3, 'user', 'active'), ($4, $5, $6, 'user', 'active')`,
    [userA, userA, 'connections-store-a@syscd.local', userB, userB, 'connections-store-b@syscd.local'],
  );
  await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [
    budgetA,
    'connections-store-test',
    userA,
  ]);
});

afterAll(async () => {
  if (!dbReady) return;
  await pool.query('DELETE FROM public.budgets WHERE id = $1', [budgetA]);
  await pool.query('DELETE FROM public.users WHERE id = ANY($1)', [[userA, userB]]);
});

describe('connections store', () => {
  test.skipIf(!dbReady)('setConnectionSyncWindow: set, clear, and CHECK bound', async () => {
    const row = await store.upsertConnection(conn({ externalId: 'up-item-store-window' }));
    expect(row.sync_window_days).toBeNull();
    expect((await store.setConnectionSyncWindow(row.id, 90)).sync_window_days).toBe(90);
    expect((await store.setConnectionSyncWindow(row.id, 0)).sync_window_days).toBe(0);
    expect((await store.setConnectionSyncWindow(row.id, null)).sync_window_days).toBeNull();
    await expect(store.setConnectionSyncWindow(row.id, 99999)).rejects.toThrow();
  });

  test.skipIf(!dbReady)('upsert: insert then idempotent re-claim keeps one row', async () => {
    const first = await store.upsertConnection(conn());
    expect(first.user_id).toBe(userA);
    expect(first.provider).toBe('testprovider');
    expect(first.external_id).toBe('up-item-store-1');
    expect(first.status).toBe('connected');
    expect(first.poll_failures).toBe(0);

    const second = await store.upsertConnection(conn({ status: 'unauthorized', clientUserId: 'cu-2' }));
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('unauthorized');
    expect(second.client_user_id).toBe('cu-2');
  });

  test.skipIf(!dbReady)('upsert: another user claiming the same upstream item is a 409', async () => {
    let caught: unknown;
    try {
      await store.upsertConnection(conn({ userId: userB }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(409);
  });

  test.skipIf(!dbReady)('scoping: list and get are user-scoped, cross-user is null', async () => {
    const mine = await store.upsertConnection(conn({ externalId: 'up-item-store-2' }));
    const userBRow = await store.upsertConnection(conn({ userId: userB, externalId: 'up-item-store-b' }));

    const list = await store.listConnectionsByUser(userA);
    const listIds = list.map((r) => r.id);
    expect(listIds).toContain(mine.id);
    expect(listIds).not.toContain(userBRow.id);

    expect(await store.getConnectionByUser(userA, mine.id)).not.toBeNull();
    expect(await store.getConnectionByUser(userB, mine.id)).toBeNull();
  });

  test.skipIf(!dbReady)('institution + disconnect updates', async () => {
    const row = await store.upsertConnection(conn({ externalId: 'up-item-store-3', institution: null }));
    const withInst = await store.setConnectionInstitution(row.id, 'Nubank');
    expect(withInst.institution).toBe('Nubank');

    await store.markDisconnected(row.id);
    const after = await store.getConnectionByUser(userA, row.id);
    expect(after!.status).toBe('disconnected');
  });

  test.skipIf(!dbReady)('setConnectionStatus stores status + message; quota pause gates the sweep until it expires', async () => {
    const row = await store.upsertConnection(conn({ externalId: 'up-item-store-4' }));
    await store.setConnectionStatus(row.id, 'unauthorized', 'Reconnect your bank');
    let fresh = await store.getConnectionByUser(userA, row.id);
    expect(fresh).toMatchObject({ status: 'unauthorized', status_message: 'Reconnect your bank' });

    const future = new Date(Date.now() + 3_600_000);
    await store.setConnectionStatus(row.id, 'quota_exhausted', 'Bank limits reached — data resumes next month', future);
    expect((await store.listSweepConnections(new Date())).map((r) => r.id)).not.toContain(row.id);
    expect((await store.listSweepConnections(new Date(future.getTime() + 1))).map((r) => r.id)).toContain(row.id);

    await store.setConnectionStatus(row.id, 'connected', null);
    fresh = await store.getConnectionByUser(userA, row.id);
    expect(fresh).toMatchObject({ status: 'connected', status_message: null, next_poll_at: null });

    // Disconnected is terminal for status writes.
    await store.markDisconnected(row.id);
    await store.setConnectionStatus(row.id, 'error', 'x');
    expect((await store.getConnectionByUser(userA, row.id))!.status).toBe('disconnected');
  });

  test.skipIf(!dbReady)('listSweepConnections: connected non-sandbox rows only', async () => {
    const live = await store.upsertConnection(conn({ externalId: 'up-item-store-due', status: 'connected' }));
    const disc = await store.upsertConnection(conn({ externalId: 'up-item-store-disc', status: 'disconnected' }));
    const sandbox = await store.upsertConnection(conn({ externalId: 'up-item-store-sandbox', environment: 'sandbox' }));
    const ids = (await store.listSweepConnections(new Date())).map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(disc.id);
    expect(ids).not.toContain(sandbox.id);
  });

  test.skipIf(!dbReady)('webhook events: dedupe + retention prune', async () => {
    const now = new Date('2020-01-01T00:00:00Z');
    const first = await store.recordWebhookEvent({
      provider: 'testprovider',
      eventId: 'evt-store-1',
      externalItemId: 'up-item-store-1',
      payload: { ok: true },
      now,
    });
    expect(first).toBe(true);
    const replay = await store.recordWebhookEvent({
      provider: 'testprovider',
      eventId: 'evt-store-1',
      externalItemId: 'up-item-store-1',
      payload: { ok: true },
      now,
    });
    expect(replay).toBe(false);

    await store.forgetWebhookEvent('evt-store-1');
    expect(
      await store.recordWebhookEvent({ provider: 'testprovider', eventId: 'evt-store-1', externalItemId: 'up-item-store-1', payload: {}, now }),
    ).toBe(true);

    // Prune: the old-marked event (received_at backdated) is swept, fresh one stays.
    await pool.query(
      `update public.connection_events set received_at = $1 where provider = $2 and event_id = 'evt-store-1'`,
      [new Date(Date.now() - 40 * 86_400_000), 'testprovider'],
    );
    const removed = await store.pruneConnectionEvents(new Date(Date.now() - 30 * 86_400_000));
    expect(removed).toBeGreaterThan(0);
    const left = await pool.query<{ event_id: string }>(
      `select event_id from public.connection_events where provider = 'testprovider' and event_id = 'evt-store-1'`,
    );
    expect(left.rowCount).toBe(0);
  });
});
