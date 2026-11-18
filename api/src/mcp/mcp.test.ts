/**
 * /mcp tests. Auth + listing + error mapping run with a stub catalog (no DB);
 * the DB-gated block runs the REAL budget routes in-process behind the router
 * to prove ownership and balances flow through the API, not around it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Hono } from 'hono';
import { z } from '@shared/zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP, implement } from '../core/operation';
import { mountOperations } from '../core/operation';
import { httpOnError } from '../core/validate';
import { createMcpRouter } from './index';

const META = 'http://api.test/.well-known/oauth-protected-resource';

const read = defineOperation({
  name: 'demo_items_list',
  description: 'List items.',
  input: z.object({ owner: z.string() }),
  method: 'GET',
  path: '/items',
  kind: 'read',
  expose: EXPOSE_ALL,
});
const write = defineOperation({
  name: 'demo_items_create',
  description: 'Create an item.',
  input: z.object({ owner: z.string(), label: z.string().min(1) }),
  method: 'POST',
  path: '/items',
  status: 201,
  kind: 'write',
  expose: EXPOSE_ALL,
});
const wipe = defineOperation({
  name: 'demo_items_delete',
  description: 'Delete an item.',
  input: z.object({ id: z.string() }),
  method: 'DELETE',
  path: '/items/:id',
  kind: 'destructive',
  expose: EXPOSE_ALL,
});
const hidden = defineOperation({
  name: 'demo_hidden',
  description: 'Not for agents.',
  input: z.object({}),
  method: 'GET',
  path: '/hidden',
  kind: 'read',
  expose: EXPOSE_NO_MCP,
});
const ops = [
  implement(read, (_c, { owner }) => [{ owner }]),
  implement(write, (c, { owner, label }) => ({ owner, label, auth: c.req.header('Authorization') ?? null })),
  implement(wipe, () => undefined),
  implement(hidden, () => ({})),
];

function build(opts: { authDisabled: boolean }) {
  const app = new Hono();
  app.onError(httpOnError);
  app.use('*', async (c, next) => {
    // Stand-in for the auth gate: the API only answers with a bearer.
    if (!opts.authDisabled && !c.req.header('Authorization')) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
  mountOperations(app, ops);
  const outer = new Hono();
  outer.route(
    '/',
    createMcpRouter({
      contracts: ops.map((o) => o.contract),
      dispatch: (req) => Promise.resolve(app.fetch(req)),
      resourceMetadataUrl: META,
      authDisabled: () => opts.authDisabled,
      authenticate: async (h) => {
        if (h === 'Bearer rw') return { scope: 'read write' };
        if (h === 'Bearer ro') return { scope: 'read' };
        return null;
      },
    }),
  );
  return outer;
}

async function connect(app: Hono, token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL('http://api.test/mcp'), {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch,
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}

const post = (app: Hono, headers: Record<string, string> = {}, body = '{}') =>
  app.fetch(new Request('http://api.test/mcp', { method: 'POST', headers, body }));

describe('/mcp auth', () => {
  const app = build({ authDisabled: false });

  test('no token -> 401 with resource_metadata challenge, before Accept/body checks', async () => {
    const res = await post(app); // no Accept, junk body
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${META}"`);
  });

  test('invalid token -> 401 with the same challenge', async () => {
    const res = await post(app, { Authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${META}"`);
  });

  test('GET and DELETE -> 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await app.fetch(new Request('http://api.test/mcp', { method }));
      expect(res.status).toBe(405);
    }
  });
});

describe('/mcp tools (generated from the catalog)', () => {
  const app = build({ authDisabled: false });

  test('write scope lists every mcp-exposed operation with kind annotations', async () => {
    const client = await connect(app, 'rw');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['demo_items_create', 'demo_items_delete', 'demo_items_list']);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.demo_items_list!.annotations?.readOnlyHint).toBe(true);
    expect(by.demo_items_delete!.annotations?.destructiveHint).toBe(true);
    expect(by.demo_items_create!.annotations?.readOnlyHint).toBe(false);
    const props = by.demo_items_create!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['label', 'owner']);
    await client.close();
  });

  test('read-only scope lists only read tools and cannot call a write tool', async () => {
    const client = await connect(app, 'ro');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['demo_items_list']);
    const res = await client.callTool({ name: 'demo_items_create', arguments: { owner: 'a', label: 'x' } });
    expect(res.isError).toBe(true);
    await client.close();
  });

  test('a read tool returns the API JSON; the caller bearer is forwarded on writes', async () => {
    const client = await connect(app, 'rw');
    const r = await client.callTool({ name: 'demo_items_list', arguments: { owner: 'zed' } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual([{ owner: 'zed' }]);
    const w = await client.callTool({ name: 'demo_items_create', arguments: { owner: 'zed', label: 'x' } });
    expect(JSON.parse((w.content as { text: string }[])[0]!.text)).toEqual({ owner: 'zed', label: 'x', auth: 'Bearer rw' });
    await client.close();
  });

  test('API errors become isError results carrying the API text', async () => {
    const client = await connect(app, 'rw');
    const bad = await client.callTool({ name: 'demo_items_create', arguments: { owner: 'a', label: '' } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  test('auth disabled: works without a token', async () => {
    const dev = build({ authDisabled: true });
    const client = await connect(dev);
    expect((await client.listTools()).tools.length).toBe(3);
    await client.close();
  });
});

// ---- real budget routes (DB) ------------------------------------------------
let pool: import('pg').Pool | null = null;
let dbReady = false;
try {
  pool = (await import('../core/db')).pool;
  await pool.query('SELECT 1');
  dbReady = (await pool.query("select to_regclass('public.budget_members')::text as t")).rows[0]?.t != null;
} catch {
  pool = null;
}

describe.skipIf(!dbReady)('/mcp over the real budget API', () => {
  const ownerId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  const budgetId = crypto.randomUUID();
  const otherBudget = crypto.randomUUID();
  let accountId = '';
  let app: Hono;

  beforeAll(async () => {
    const budget = (await import('../budget')).default;
    const { contracts } = await import('../catalog');
    for (const [id, tag] of [
      [ownerId, 'owner'],
      [otherId, 'other'],
    ] as const) {
      await pool!.query(`INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')`, [
        id,
        `mcp-${tag}@syscd.local`,
      ]);
    }
    for (const [b, u] of [
      [budgetId, ownerId],
      [otherBudget, otherId],
    ] as const) {
      await pool!.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [b, 'mcp-budget', u]);
      await pool!.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [b, u]);
    }
    const api = new Hono();
    api.onError(httpOnError);
    api.use('*', (c, next) => {
      // Stand-in for the gate + requireUser: bearer "u:<id>" is that user.
      const id = c.req.header('Authorization')?.replace('Bearer u:', '') ?? '';
      c.set('user', { id, email: `mcp-${id === ownerId ? 'owner' : 'other'}@syscd.local`, googleSub: null, role: 'user', status: 'active' });
      return next();
    });
    api.route('/', budget);
    app = new Hono();
    app.route(
      '/',
      createMcpRouter({
        contracts,
        dispatch: (req) => Promise.resolve(api.fetch(req)),
        resourceMetadataUrl: META,
        authDisabled: () => false,
        authenticate: async (h) => (h?.startsWith('Bearer u:') ? { scope: 'read write' } : null),
      }),
    );
    const client = await connect(app, `u:${ownerId}`);
    const acc = await client.callTool({
      name: 'budget_accounts_create',
      arguments: { budget_id: budgetId, name: 'Checking', type: 'checking', user_id: null },
    });
    accountId = JSON.parse((acc.content as { text: string }[])[0]!.text).id;
    await client.close();
  });

  afterAll(async () => {
    await pool!.query('DELETE FROM budgets WHERE id = ANY($1)', [[budgetId, otherBudget]]);
    await pool!.query('DELETE FROM public.users WHERE id = ANY($1)', [[ownerId, otherId]]);
  });

  test('tools are generated from the catalog, incl. budget_transaction_add; destructive budget ops stay out', async () => {
    const client = await connect(app, `u:${ownerId}`);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('budget_list');
    expect(names).toContain('budget_transaction_add');
    expect(names).not.toContain('budget_delete');
    await client.close();
  });

  test('a read tool returns the caller\'s own data and a foreign budget id is an error result', async () => {
    const client = await connect(app, `u:${ownerId}`);
    const mine = await client.callTool({ name: 'budget_accounts_list', arguments: { budget_id: budgetId } });
    expect(mine.isError).toBeFalsy();
    expect(JSON.parse((mine.content as { text: string }[])[0]!.text).map((a: { id: string }) => a.id)).toContain(accountId);
    const foreign = await client.callTool({ name: 'budget_accounts_list', arguments: { budget_id: otherBudget } });
    expect(foreign.isError).toBe(true);
    expect((foreign.content as { text: string }[])[0]!.text).toContain('not found');
    await client.close();
  });

  test('budget_transaction_add creates the row by payee name and moves the balance', async () => {
    const client = await connect(app, `u:${ownerId}`);
    const added = await client.callTool({
      name: 'budget_transaction_add',
      arguments: { budget_id: budgetId, account_id: accountId, amount: -12500, payee: 'Corner Cafe', date: '2025-03-04', memo: 'lunch' },
    });
    expect(added.isError).toBeFalsy();
    const row = JSON.parse((added.content as { text: string }[])[0]!.text);
    expect(row.amount).toBe(-12500);
    expect(row.date.slice(0, 10)).toBe('2025-03-04');
    const payee = await pool!.query('SELECT name FROM payees WHERE id = $1', [row.payee_id]);
    expect(payee.rows[0].name).toBe('Corner Cafe');
    const bal = await pool!.query('SELECT cleared_balance, uncleared_balance FROM accounts WHERE id = $1', [accountId]);
    expect(Number(bal.rows[0].uncleared_balance)).toBe(-12500);
    expect(Number(bal.rows[0].cleared_balance)).toBe(0);

    const foreign = await client.callTool({
      name: 'budget_transaction_add',
      arguments: { budget_id: otherBudget, account_id: accountId, amount: -10, payee: 'x' },
    });
    expect(foreign.isError).toBe(true);
    await client.close();
  });
});
