/**
 * Tests for the budget operation catalog: every declared operation is listed,
 * unique, snake_case, mounted at its declared method+path, and every read is
 * a GET (read-only OAuth tokens may only issue GET/HEAD/OPTIONS). DB-gated:
 * every generated route that addresses a budget still answers a non-owner
 * with 404 `not found` (budgetAccess protects the generated routes exactly as
 * it did the hand-written ones), and the owner passes the guard.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

import { ApiError, createApiClient } from '../core/client';
import { inputLocations } from '@shared/operation-contract';
import type { IdentityUser } from '../user';
import budgetApp, { operations } from './index';
import { contracts as fullCatalog } from '../catalog';

let pool: Pool | null = null;
let dbReady = false;
try {
  pool = (await import('../core/db')).pool;
  await pool.query('SELECT 1');
  dbReady = (await pool.query("select to_regclass('public.budget_members')::text as t")).rows[0]?.t != null;
} catch {
  pool = null;
  dbReady = false;
}

const { Hono } = await import('hono');
const { httpOnError } = await import('../core/validate');

const ownerId = crypto.randomUUID();
const strangerId = crypto.randomUUID();
const budgetId = crypto.randomUUID();
let currentUser: IdentityUser | undefined;

const mkUser = (id: string, tag: string): IdentityUser => ({
  id,
  email: `opcat-${tag}@syscd.local`,
  googleSub: null,
  role: 'user',
  status: 'active',
});
const owner = mkUser(ownerId, 'owner');
const stranger = mkUser(strangerId, 'stranger');

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', currentUser);
  return next();
});
app.route('/', budgetApp);

const client = createApiClient({ baseUrl: 'http://api.test', fetch: (req) => Promise.resolve(app.fetch(req)) });

// The catalog spans every feature; these tests cover the budget slice (other
// features' operations are covered by their own suites + the uniqueness test).
const catalog = [...operations];

describe('operation catalog (all features)', () => {
  test('operation names are unique across features', () => {
    const names = fullCatalog.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('user_me_update');
  });
});

describe('budget operation catalog', () => {
  test('server/catalog.ts lists every budget operation, names unique and snake_case', () => {
    const names = catalog.map((o) => o.contract.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^budget_[a-z0-9]+(_[a-z0-9]+)*$/);
    expect(new Set(fullCatalog.filter((c) => c.name.startsWith('budget_')))).toEqual(new Set(operations.map((o) => o.contract)));
  });

  test('every routes/*.ts file contributes its operations to the catalog (19 routers)', async () => {
    const files = readdirSync(join(import.meta.dir, 'routes')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBe(19);
    const listed = new Set(catalog);
    for (const file of files) {
      const mod = (await import(`./routes/${file}`)) as { operations: unknown[] };
      expect(mod.operations.length).toBeGreaterThan(0);
      for (const op of mod.operations) expect(listed.has(op as never)).toBe(true);
    }
  });

  test('every api-exposed operation is mounted at its method + path', () => {
    const mounted = new Set(budgetApp.routes.map((r) => `${r.method} ${r.path}`));
    for (const { contract } of catalog) {
      if (!contract.expose.api) continue;
      expect(mounted.has(`${contract.method} ${contract.path}`)).toBe(true);
    }
  });

  test('reads are GET, mutations are not; destructive budget ops are not MCP-exposed', () => {
    for (const { contract } of catalog) {
      if (contract.kind === 'read') expect(contract.method).toBe('GET');
      else expect(contract.method).not.toBe('GET');
    }
    const byName = new Map(catalog.map((o) => [o.contract.name, o.contract]));
    for (const name of ['budget_delete', 'budget_fresh_start', 'budget_restore']) {
      const c = byName.get(name)!;
      expect(c.kind).toBe('destructive');
      expect(c.expose.mcp).toBe(false);
      expect(c.expose.api).toBe(true);
    }
  });

  test('every input key has exactly one location', () => {
    for (const { contract } of catalog) {
      const loc = inputLocations(contract);
      const all = [...loc.path, ...loc.query, ...loc.body, ...(contract.bodyKey ? [contract.bodyKey] : [])];
      expect(new Set(all).size).toBe(all.length);
      expect([...all].sort()).toEqual(Object.keys(contract.input.shape).sort());
    }
  });
});

describe.skipIf(!dbReady)('generated routes keep budgetAccess ownership (404 for non-owners)', () => {
  beforeAll(async () => {
    for (const u of [owner, stranger]) {
      await pool!.query(
        `INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')`,
        [u.id, u.email],
      );
    }
    await pool!.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [budgetId, 'opcat-budget', ownerId]);
    await pool!.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [budgetId, ownerId]);
  });

  afterAll(async () => {
    await pool!.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
    await pool!.query('DELETE FROM public.users WHERE id = ANY($1)', [[ownerId, strangerId]]);
  });

  const someId = crypto.randomUUID();
  /** Plausible values for every key an operation might declare. */
  const sample = {
    budget_id: budgetId,
    id: someId,
    categoryId: someId,
    user_id: someId,
    month: '2025-01-01',
    email: 'someone@example.com',
    name: 'x',
  };

  test('a non-owner gets 404 `not found` on every generated route that addresses a budget', async () => {
    currentUser = stranger;
    let checked = 0;
    for (const { contract } of catalog) {
      if (!('budget_id' in contract.input.shape)) continue;
      const input = Object.fromEntries(Object.keys(contract.input.shape).map((k) => [k, (sample as Record<string, unknown>)[k]]).filter(([, v]) => v !== undefined));
      const err = await client.call(contract, input).catch((e: unknown) => e);
      expect(err, contract.name).toBeInstanceOf(ApiError);
      expect((err as ApiError).status, contract.name).toBe(404);
      checked += 1;
    }
    // Everything except the budgets list/create/rename/archive/unarchive/delete ops.
    expect(checked).toBeGreaterThan(40);
  });

  test('a non-owner is also refused on the budgets-router operations (owner scoped in SQL)', async () => {
    currentUser = stranger;
    const byName = new Map(catalog.map((o) => [o.contract.name, o.contract]));
    for (const name of ['budget_rename', 'budget_archive', 'budget_unarchive', 'budget_delete']) {
      const err = await client.call(byName.get(name)!, { id: budgetId, name: 'hijack' }).catch((e: unknown) => e);
      expect((err as ApiError).status, name).toBe(404);
    }
    const list = (await client.call(byName.get('budget_list')!)) as { id: string }[];
    expect(list.some((b) => b.id === budgetId)).toBe(false);
    const still = await pool!.query('SELECT name FROM budgets WHERE id = $1', [budgetId]);
    expect(still.rows[0].name).toBe('opcat-budget');
  });

  test('the owner passes the guard and is served by the generated route', async () => {
    currentUser = owner;
    const byName = new Map(catalog.map((o) => [o.contract.name, o.contract]));
    const created = (await client.call(byName.get('budget_groups_create')!, { budget_id: budgetId, name: 'G1' })) as { id: string; name: string };
    expect(created.name).toBe('G1');
    const groups = (await client.call(byName.get('budget_groups_list')!, { budget_id: budgetId })) as { id: string }[];
    expect(groups.map((g) => g.id)).toContain(created.id);
    const list = (await client.call(byName.get('budget_list')!)) as { id: string }[];
    expect(list.some((b) => b.id === budgetId)).toBe(true);
  });
});
