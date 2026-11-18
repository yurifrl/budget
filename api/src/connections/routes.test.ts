/**
 * Tests for server/connections/routes.ts — connect-token, item registration,
 * listing, sync, disconnect, and the account-link endpoint (PATCH /accounts/:id).
 *
 * Route exercised IN-PROCESS via app.request(). DB tests are gated on
 * Postgres reachability + migrated schema (0014) so `bun test` stays green
 * without a live DB. The provider surface is faked at the BankAggregator port
 * (installed via the registry's setAggregators seam) — no HTTP faking and no
 * live credentials involved.
 *
 * Fixtures are self-cleaning: the test users and budget created here are
 * deleted in afterAll (cascading to connections/account link columns via the
 * schema FKs), and re-created idempotently in beforeAll.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Pool } from 'pg';

import connectionsApp from './routes';
// Integration seam: connections sync writes through the real budget accounts
// router, so these tests mount the real thing via budget's public barrel.
import { accountsRouter } from '../budget';
import { setAggregators, type AggregatorEntry } from './registry';
import type { BankAggregator, ExternalAccount } from './types';
import { pool } from '../core/db';
import { runMigrations } from '../core/migrate';
import type { IdentityUser } from '../user';
import { httpOnError } from '../core/validate';

let dbReady = false;
try {
  await pool.query('SELECT 1');
  dbReady = true;
} catch {
  dbReady = false;
}

const userAId = crypto.randomUUID();
const userBId = crypto.randomUUID();
const EMAIL_A = 'connections-test-a@syscd.local';
const EMAIL_B = 'connections-test-b@syscd.local';
const budgetId = crypto.randomUUID();
const budgetBId = crypto.randomUUID();
const budgetAcc1 = crypto.randomUUID();
const budgetAcc2 = crypto.randomUUID();
const budgetAccB = crypto.randomUUID();
const UP_ITEM = 'up-item-1';

const userA = { id: userAId, email: EMAIL_A, role: 'user' } as never;
const userB = { id: userBId, email: EMAIL_B, role: 'user' } as never;

/** Identity-stub middleware — requireUser's output, satisfied directly. */
const asUser = (user: IdentityUser) =>
  (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>): Promise<void> => {
    c.set('user', user);
    return next();
  };

const appAnon = new Hono();
appAnon.onError(httpOnError);
appAnon.route('/connections', connectionsApp);

const appA = new Hono();
appA.onError(httpOnError);
appA.use('/connections/*', asUser(userA));
appA.route('/connections', connectionsApp);
appA.use('/accounts/*', asUser(userA));
appA.route('/accounts', accountsRouter);

const appB = new Hono();
appB.onError(httpOnError);
appB.use('/connections/*', asUser(userB));
appB.route('/connections', connectionsApp);
appB.use('/accounts/*', asUser(userB));
appB.route('/accounts', accountsRouter);

/** An operator: the admin role, no connections and no budgets of their own. */
const appAdmin = new Hono();
appAdmin.onError(httpOnError);
appAdmin.use('/connections/*', asUser({ id: crypto.randomUUID(), email: 'conn-admin@routes.test', role: 'admin' } as never));
appAdmin.route('/connections', connectionsApp);

const post = async (app: Hono, path: string, body: unknown): Promise<Response> =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const patch = async (app: Hono, path: string, body: unknown): Promise<Response> =>
  app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Port-level fake: records calls, fakes the upstream item + its accounts. */
const upstreamDeleted: string[] = [];
const calls: string[] = [];
let accountsDropped: number = 0;

class FakeAggregator implements BankAggregator {
  readonly environment = 'production' as const;

  async createConnectToken(): Promise<{ token: string; clientId: string | null; widgetUrl: string | null }> {
    calls.push('createConnectToken');
    return { token: 'token-1', clientId: 'cid-1', widgetUrl: 'https://conn.test/checkout' };
  }

  async listExternalAccounts(externalItemId: string): Promise<ExternalAccount[]> {
    calls.push(`listExternalAccounts:${externalItemId}`);
    const all: ExternalAccount[] = [
      {
        externalId: 'up-acc-1',
        name: 'Fake Checking',
        type: 'BANK',
        currencyCode: 'BRL',
        balance: 1_234_560,
        institution: 'Fake Bank',
      },
      {
        externalId: 'up-acc-2',
        name: 'Fake Card',
        type: 'CREDIT',
        currencyCode: 'BRL',
        balance: -100_250,
        institution: 'Fake Bank',
      },
    ];
    return all.slice(0, all.length - accountsDropped);
  }

  /** Test seam: capture every pull window the engine requested. */
  static lastPullWindow: { from?: string; to?: string } | null = null;
  async listTransactions(
    _externalAccountId: string,
    input: { from?: string; to?: string } = {},
  ): Promise<{ transactions: never[]; hasMore: false }> {
    calls.push(`listTransactions:${JSON.stringify(input)}`);
    FakeAggregator.lastPullWindow = input;
    return { transactions: [], hasMore: false };
  }

  async deleteConnection(externalId: string): Promise<void> {
    calls.push(`deleteConnection:${externalId}`);
    upstreamDeleted.push(externalId);
  }

  async fetchInstitution(): Promise<string | null> {
    return null;
  }

  async getItemState(): Promise<{ status: 'connected'; lastUpdatedAt: null }> {
    return { status: 'connected', lastUpdatedAt: null };
  }

  mapWebhookDelivery(delivery: unknown): null {
    return null;
  }

  mapStatus(): 'connected' {
    return 'connected';
  }

  verifyWebhookHeaders(): boolean {
    return true;
  }
}

const fakeAggregator = new FakeAggregator();
let adapterConfigured = true;
const fakeEntry: AggregatorEntry = {
  create: () => fakeAggregator,
  configured: () => adapterConfigured,
};

beforeAll(async () => {
  if (!dbReady) return;
  await runMigrations();
  setAggregators({ pluggy: fakeEntry });
  // Idempotent fixtures: a previous failed run may have left the self-created
  // test rows behind — drop them first (only rows this file ever creates).
  await pool.query("DELETE FROM public.users WHERE email IN ($1, $2)", [EMAIL_A, EMAIL_B]);
  await pool.query("DELETE FROM public.budgets WHERE name IN ('connections-route-test', 'connections-route-test-b')");
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status)
     VALUES ($1, null, $2, 'user', 'active'), ($3, null, $4, 'user', 'active')`,
    [userAId, EMAIL_A, userBId, EMAIL_B],
  );
  await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3), ($4, $5, $6)', [
    budgetId,
    'connections-route-test',
    userAId,
    budgetBId,
    'connections-route-test-b',
    userBId,
  ]);
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group)
     VALUES ($1, $2, $3, 'checking', 'CASH'), ($4, $2, $5, 'checking', 'CASH'), ($6, $7, $8, 'checking', 'CASH')`,
    [budgetAcc1, budgetId, 'Connections Test Checking', budgetAcc2, 'Connections Test Savings', budgetAccB, budgetBId, 'Connections Test B'],
  );
});

afterAll(async () => {
  setAggregators(null);
  if (!dbReady) return;
  await pool.query('DELETE FROM jobs.job_runs WHERE tenant_id = ANY($1::uuid[])', [[userAId, userBId]]);
  await pool.query('DELETE FROM public.budgets WHERE id = ANY($1::uuid[])', [[budgetId, budgetBId]]);
  await pool.query('DELETE FROM public.users WHERE id = ANY($1::uuid[])', [[userAId, userBId]]);
});

describe('connections routes', () => {
  test('exports a Hono app', () => {
    expect(typeof connectionsApp.request).toBe('function');
  });

  test.skipIf(!dbReady)('requires an identity (401 without requireUser output)', async () => {
    const res = await appAnon.request('/connections');
    expect(res.status).toBe(401);
  });

  test.skipIf(!dbReady)('POST /connect-token returns the widget token', async () => {
    calls.length = 0;
    const res = await post(appA, '/connections/connect-token', { provider: 'pluggy' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      token: 'token-1',
      clientId: 'cid-1',
      widgetUrl: 'https://conn.test/checkout',
    });
    expect(calls).toEqual(['createConnectToken']);
  });

  test.skipIf(!dbReady)('unknown provider → 404, before any configuration check', async () => {
    const res = await post(appA, '/connections/connect-token', { provider: 'nope' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('unknown connections provider');
  });

  test.skipIf(!dbReady)('registered but unconfigured provider → 503', async () => {
    adapterConfigured = false;
    try {
      const res = await post(appA, '/connections/connect-token', { provider: 'pluggy' });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain('not configured');
    } finally {
      adapterConfigured = true;
    }
  });

  test.skipIf(!dbReady)('POST /items registers the connection and returns external accounts', async () => {
    calls.length = 0;
    const res = await post(appA, '/connections/items', { provider: 'pluggy', itemId: UP_ITEM });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connection.provider).toBe('pluggy');
    expect(body.connection.external_id).toBe(UP_ITEM);
    expect(body.connection.status).toBe('connected');
    expect(body.connection.environment).toBe('production');
    expect(body.connection.institution).toBe('Fake Bank');
    expect(body.accounts).toHaveLength(2);
    expect(body.accounts[0].externalId).toBe('up-acc-1');
    expect(calls).toContain('listExternalAccounts:up-item-1');
  });

  test.skipIf(!dbReady)('re-registering the same item is idempotent', async () => {
    const first = await post(appA, '/connections/items', { provider: 'pluggy', itemId: UP_ITEM });
    const again = await post(appA, '/connections/items', { provider: 'pluggy', itemId: UP_ITEM });
    expect(again.status).toBe(200);
    expect((await again.json()).connection.id).toBe((await first.json()).connection.id);
    const count = await pool!.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.connections WHERE provider = $1 AND external_id = $2',
      ['pluggy', UP_ITEM],
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });

  test.skipIf(!dbReady)('another user registering the same upstream item → 409', async () => {
    const res = await post(appB, '/connections/items', { provider: 'pluggy', itemId: UP_ITEM });
    expect(res.status).toBe(409);
  });

  test.skipIf(!dbReady)('GET / lists only the caller’s connections', async () => {
    const mine = await appA.request('/connections');
    expect(mine.status).toBe(200);
    const mineBody = await mine.json();
    expect(mineBody).toHaveLength(1);
    expect(mineBody[0].external_id).toBe(UP_ITEM);

    const theirs = await appB.request('/connections');
    expect(await theirs.json()).toEqual([]);
  });

  test.skipIf(!dbReady)('GET /:id — cross-user ids surface as 404', async () => {
    const listed = (await (await appA.request('/connections')).json())[0];
    const mine = await appA.request(`/connections/${listed.id}`);
    expect(mine.status).toBe(200);

    const theirs = await appB.request(`/connections/${listed.id}`);
    expect(theirs.status).toBe(404);

    const bogus = await appA.request(`/connections/${crypto.randomUUID()}`);
    expect(bogus.status).toBe(404);
  });

  test.skipIf(!dbReady)('linked_by: who linked the bank, on connections and on the budget accounts list', async () => {
    const expected = {
      user_id: userAId,
      name: null,
      email: EMAIL_A,
      avatar: { seed: userAId, image_version: null },
    };
    const listed = (await (await appA.request('/connections')).json())[0];
    expect(listed.linked_by).toEqual(expected);
    expect((await (await appA.request(`/connections/${listed.id}`)).json()).linked_by).toEqual(expected);
    const upstream = await (await appA.request('/connections/upstream')).json();
    expect(upstream[0].connection.linked_by).toEqual(expected);
    // A write path answers with the same shape.
    const updated = await patch(appA, `/connections/${listed.id}/settings`, { syncWindowDays: null });
    expect((await updated.json()).linked_by).toEqual(expected);

    await pool.query('UPDATE public.users SET name = $2, avatar_seed = $3 WHERE id = $1', [userAId, 'Ana', 'seed-ana']);
    try {
      const linked = await patch(appA, `/accounts/${budgetAcc1}`, {
        budget_id: budgetId,
        link: { connectionId: listed.id, externalAccountId: 'up-acc-1' },
      });
      expect(linked.status).toBe(200);
      const rows = await (await appA.request(`/accounts?budget_id=${budgetId}`)).json();
      const linkedRow = rows.find((r: { id: string }) => r.id === budgetAcc1);
      expect(linkedRow.linked_by).toEqual({
        user_id: userAId,
        name: 'Ana',
        email: EMAIL_A,
        avatar: { seed: 'seed-ana', image_version: null },
      });
      // No leaked join columns; unlinked accounts carry null.
      expect(Object.keys(linkedRow).filter((k) => k.startsWith('ref_') || k.startsWith('avatar_'))).toEqual([]);
      expect(rows.find((r: { id: string }) => r.id === budgetAcc2).linked_by).toBeNull();
    } finally {
      await patch(appA, `/accounts/${budgetAcc1}`, { budget_id: budgetId, link: { connectionId: null } });
      await pool.query('UPDATE public.users SET name = NULL, avatar_seed = NULL WHERE id = $1', [userAId]);
    }
  });

  test.skipIf(!dbReady)('PATCH /accounts/:id links, defaults institution, 404 on foreign connection, null unlinks', async () => {
    const listed = (await (await appA.request('/connections')).json())[0];
    const connectionId = listed.id;

    const linked = await patch(appA, `/accounts/${budgetAcc1}`, {
      budget_id: budgetId,
      link: { connectionId, externalAccountId: 'up-acc-1' },
    });
    expect(linked.status).toBe(200);
    const linkedRow = await linked.json();
    expect(linkedRow.connection_id).toBe(connectionId);
    expect(linkedRow.external_account_id).toBe('up-acc-1');
    // Institution defaults from the connection when not supplied.
    expect(linkedRow.institution).toBe('Fake Bank');

    // Another user's connection id is indistinguishable from a bogus one → 404.
    const foreign = await patch(appA, `/accounts/${budgetAcc1}`, {
      budget_id: budgetId,
      link: { connectionId: crypto.randomUUID(), externalAccountId: 'up-acc-1' },
    });
    expect(foreign.status).toBe(404);

    // Linking requires an external account id.
    const noExternal = await patch(appA, `/accounts/${budgetAcc1}`, {
      budget_id: budgetId,
      link: { connectionId },
    });
    expect(noExternal.status).toBe(400);

    const unlinked = await patch(appA, `/accounts/${budgetAcc1}`, {
      budget_id: budgetId,
      link: { connectionId: null },
    });
    expect(unlinked.status).toBe(200);
    const unlinkedRow = await unlinked.json();
    expect(unlinkedRow.connection_id).toBeNull();
    expect(unlinkedRow.external_account_id).toBeNull();
    expect(unlinkedRow.institution).toBeNull();
  });

  test.skipIf(!dbReady)('PATCH /accounts/:id on another owner’s budget → 404 (budgetAccess)', async () => {
    const res = await patch(appA, `/accounts/${budgetAccB}`, {
      budget_id: budgetBId,
      name: 'hijack',
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not found');
  });

  test.skipIf(!dbReady)('POST /:id/sync enqueues a coalesced job and never calls the provider', async () => {
    calls.length = 0;
    const listed = (await (await appA.request('/connections')).json())[0];
    const res = await post(appA, `/connections/${listed.id}/sync`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connection.id).toBe(listed.id);
    expect(body.run).toMatchObject({ status: 'queued', mode: 'sync' });
    expect(body.created).toBe(true);
    // A second request joins the active run (Q16 coalescing).
    const again = await (await post(appA, `/connections/${listed.id}/sync`, {})).json();
    expect(again.created).toBe(false);
    expect(again.run.id).toBe(body.run.id);
    expect(calls).toEqual([]); // the HTTP path never touches the provider
  });

  test.skipIf(!dbReady)('POST /:id/reimport gets its own run, queued alongside an active sync', async () => {
    const listed = (await (await appA.request('/connections')).json())[0];
    const sync = await (await post(appA, `/connections/${listed.id}/sync`, {})).json();
    const res = await post(appA, `/connections/${listed.id}/reimport`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.mode).toBe('reimport');
    expect(body.run.id).not.toBe(sync.run.id);
    const subject = await pool.query<{ subject_key: string }>('select subject_key from jobs.job_runs where id = $1', [body.run.id]);
    expect(subject.rows[0]!.subject_key).toBe(`${listed.id}:reimport`);
  });

  test.skipIf(!dbReady)('GET /sync-status: owner-scoped, shows the queued run and degraded scheduler', async () => {
    const listed = (await (await appA.request('/connections')).json())[0];
    await post(appA, `/connections/${listed.id}/sync`, {});
    const res = await appA.request('/connections/sync-status');
    expect(res.status).toBe(200);
    const body = await res.json();
    // No Temporal client is configured in tests → scheduler reads as down.
    expect(body.scheduler_degraded).toBe(true);
    const mine = body.connections.find((c: { id: string }) => c.id === listed.id);
    expect(mine.state).toBe('queued_offline');
    expect(mine.active_run.status).toBe('queued');
    const theirs = await (await appB.request('/connections/sync-status')).json();
    expect(theirs.connections.find((c: { id: string }) => c.id === listed.id)).toBeUndefined();
  });

  test.skipIf(!dbReady)('POST /:id/sync — cross-user → 404', async () => {
    const listed = (await (await appA.request('/connections')).json())[0];
    const res = await post(appB, `/connections/${listed.id}/sync`, {});
    expect(res.status).toBe(404);
  });

  test.skipIf(!dbReady)('upstream failure → 502 carrying the provider detail', async () => {
    const original = FakeAggregator.prototype.createConnectToken;
    FakeAggregator.prototype.createConnectToken = async () => {
      throw new Error('upstream exploded\nwith details');
    };
    try {
      const res = await post(appA, '/connections/connect-token', { provider: 'pluggy' });
      expect(res.status).toBe(502);
      // The provider's own message survives (sanitized), so users see WHY.
      expect((await res.json()).error).toBe('provider request failed: upstream exploded with details');
    } finally {
      FakeAggregator.prototype.createConnectToken = original;
    }
  });

  test.skipIf(!dbReady)('provider schema failure → 502 with a human message, no raw zod issues', async () => {
    const original = FakeAggregator.prototype.createConnectToken;
    const { z } = await import('zod');
    const origErr = console.error;
    console.error = () => {};
    FakeAggregator.prototype.createConnectToken = async () => {
      z.object({ billId: z.string() }).parse({});
      throw new Error('unreachable');
    };
    try {
      const res = await post(appA, '/connections/connect-token', { provider: 'pluggy' });
      expect(res.status).toBe(502);
      const msg = (await res.json()).error as string;
      expect(msg).toContain("Couldn't sync with the bank");
      expect(msg).not.toContain('invalid_type');
    } finally {
      console.error = origErr;
      FakeAggregator.prototype.createConnectToken = original;
    }
  });

  test.skipIf(!dbReady)('PATCH /:id/settings: per-bank window set, cleared, bounded, owner-scoped', async () => {
    const listed = (await (await appA.request('/connections')).json())[0];
    expect(listed.sync_window_days).toBeNull();

    const set = await patch(appA, `/connections/${listed.id}/settings`, { syncWindowDays: 30 });
    expect(set.status).toBe(200);
    expect((await set.json()).sync_window_days).toBe(30);
    expect((await (await appA.request(`/connections/${listed.id}`)).json()).sync_window_days).toBe(30);

    const tooWide = await patch(appA, `/connections/${listed.id}/settings`, { syncWindowDays: 99999 });
    expect(tooWide.status).toBe(400);

    const theirs = await patch(appB, `/connections/${listed.id}/settings`, { syncWindowDays: 7 });
    expect(theirs.status).toBe(404);

    const cleared = await patch(appA, `/connections/${listed.id}/settings`, { syncWindowDays: null });
    expect((await cleared.json()).sync_window_days).toBeNull();
  });

  test.skipIf(!dbReady)('DELETE /:id is blocked with 409 while accounts stay linked', async () => {
    const listed = (await (await appA.request('/connections')).json())[0];
    await patch(appA, `/accounts/${budgetAcc1}`, {
      budget_id: budgetId,
      link: { connectionId: listed.id, externalAccountId: 'up-acc-1' },
    });
    const blocked = await appA.request(`/connections/${listed.id}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toContain('unlink in the account editor');

    // Unlink first, then removal proceeds.
    await patch(appA, `/accounts/${budgetAcc1}`, { budget_id: budgetId, link: { connectionId: null } });
    const allowed = await appA.request(`/connections/${listed.id}`, { method: 'DELETE' });
    expect(allowed.status).toBe(200);
  });

  test.skipIf(!dbReady)('DELETE /:id disconnects upstream + locally; cross-user → 404', async () => {
    upstreamDeleted.length = 0;
    const listed = (await (await appA.request('/connections')).json())[0];
    const theirs = await appB.request(`/connections/${listed.id}`, { method: 'DELETE' });
    expect(theirs.status).toBe(404);

    const res = await appA.request(`/connections/${listed.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(upstreamDeleted).toEqual([UP_ITEM]);

    const after = await appA.request(`/connections/${listed.id}`);
    expect((await after.json()).status).toBe('disconnected');
  });

  test.skipIf(!dbReady)('settings: default All, round-trip, and bounds (the app-wide value is admin-only)', async () => {
    const initial = await appA.request('/connections/settings');
    expect(initial.status).toBe(200);
    expect((await initial.json()).syncWindowDays).toBe(0);

    // One value for everybody's syncs: an ordinary user reads it, never sets it.
    const denied = await patch(appA, '/connections/settings', { syncWindowDays: 7 });
    expect(denied.status).toBe(403);
    expect((await (await appA.request('/connections/settings')).json()).syncWindowDays).toBe(0);

    const capped = await patch(appAdmin, '/connections/settings', { syncWindowDays: 90 });
    expect(capped.status).toBe(200);
    expect((await capped.json()).syncWindowDays).toBe(90);
    expect((await (await appA.request('/connections/settings')).json()).syncWindowDays).toBe(90);

    const back = await patch(appAdmin, '/connections/settings', { syncWindowDays: 0 });
    expect((await back.json()).syncWindowDays).toBe(0);

    const tooWide = await patch(appAdmin, '/connections/settings', { syncWindowDays: 99999 });
    expect(tooWide.status).toBe(400);
  });
});
