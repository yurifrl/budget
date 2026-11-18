/**
 * Connections operation catalog + ownership: the generated routes scope every
 * lookup to the session user, so another user's connection id is
 * indistinguishable from an unknown one (404). DB-gated.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Pool } from 'pg';

import { ApiError, createApiClient } from '../core/client';
import { describeOperationCatalog } from '../core/operation-catalog-test';
import { httpOnError } from '../core/validate';
import type { IdentityUser } from '../user';
import connectionsApp, { operations } from './index';

describeOperationCatalog('connections', operations, connectionsApp, '/connections');

describe('connections MCP curation', () => {
  test('mcp-exposed set is exactly the curated list; webhook and connect-token are not operations', () => {
    const mcp = operations.filter((o) => o.contract.expose.mcp).map((o) => o.contract.name).sort();
    expect(mcp).toEqual(['connections_accounts_summary', 'connections_get', 'connections_list', 'connections_sync', 'connections_sync_status', 'connections_transactions_list', 'connections_upstream_list']);
    const paths = operations.map((o) => o.contract.path);
    expect(paths.some((p) => p.includes('webhook') || p.includes('connect-token'))).toBe(false);
  });
});

let pool: Pool | null = null;
let dbReady = false;
try {
  pool = (await import('../core/db')).pool;
  await pool.query('SELECT 1');
  dbReady = (await pool.query("select to_regclass('public.connections')::text as t")).rows[0]?.t != null;
} catch {
  pool = null;
  dbReady = false;
}

const mkUser = (tag: string): IdentityUser => ({
  id: crypto.randomUUID(),
  email: `connections-opcat-${tag}@syscd.local`,
  googleSub: null,
  role: 'user',
  status: 'active',
});
const alice = mkUser('alice');
const bob = mkUser('bob');
let currentUser: IdentityUser | undefined;

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  if (currentUser) c.set('user', currentUser);
  return next();
});
app.route('/connections', connectionsApp);
const client = createApiClient({ baseUrl: 'http://api.test', fetch: (req) => Promise.resolve(app.fetch(req)) });
const op = (name: string) => operations.find((o) => o.contract.name === name)!.contract;

describe.skipIf(!dbReady)('generated connections routes are scoped to the session user', () => {
  let aliceConnectionId = '';

  beforeAll(async () => {
    for (const u of [alice, bob]) {
      await pool!.query(`INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')`, [u.id, u.email]);
    }
    const { upsertConnection } = await import('./store');
    const row = await upsertConnection({
      userId: alice.id,
      provider: 'opcat-test-provider',
      externalId: `opcat-${crypto.randomUUID()}`,
      status: 'connected',
    });
    aliceConnectionId = row.id;
  });
  afterAll(async () => {
    await pool!.query('DELETE FROM public.users WHERE id = ANY($1)', [[alice.id, bob.id]]);
  });

  test('without an identity every operation answers 401', async () => {
    currentUser = undefined;
    for (const name of ['connections_list', 'connections_get']) {
      const err = await client.call(op(name), { id: aliceConnectionId }).catch((e: unknown) => e);
      expect((err as ApiError).status, name).toBe(401);
    }
  });

  test('the owner sees their connection', async () => {
    currentUser = alice;
    const list = (await client.call(op('connections_list'))) as { id: string }[];
    expect(list.map((r) => r.id)).toContain(aliceConnectionId);
    expect(((await client.call(op('connections_get'), { id: aliceConnectionId })) as { id: string }).id).toBe(aliceConnectionId);
  });

  test("another user cannot list, read, sync, re-import or delete someone else's connection (404)", async () => {
    currentUser = bob;
    const list = (await client.call(op('connections_list'))) as { id: string }[];
    expect(list.map((r) => r.id)).not.toContain(aliceConnectionId);
    for (const name of ['connections_get', 'connections_sync', 'connections_reimport', 'connections_delete']) {
      const err = await client.call(op(name), { id: aliceConnectionId }).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(ApiError);
      expect((err as ApiError).status, name).toBe(404);
    }
    const row = await pool!.query('SELECT status FROM public.connections WHERE id = $1', [aliceConnectionId]);
    expect(row.rows[0].status).toBe('connected');
  });
});
