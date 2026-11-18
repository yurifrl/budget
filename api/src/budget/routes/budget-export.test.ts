/**
 * Tests for server/budget/routes/budget-export.ts — GET /budgets/export.
 *
 * In-process via app.request(), gated on a migrated Postgres like the restore
 * tests. Round trip: seed -> export -> restore into a fresh budget -> export
 * again -> equal (ids never appear in the payload, so equality is direct).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Pool } from 'pg';

import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';

let pool: Pool | null = null;
let dbReady = false;

try {
  const db = await import('../../core/db');
  pool = db.pool;
  await pool.query('SELECT 1');
  const schema = await pool.query<{ t: string | null }>("select to_regclass('public.transactions')::text as t");
  dbReady = schema.rows[0]?.t != null;
} catch {
  pool = null;
  dbReady = false;
}

const exportApp = (await import('./budget-export')).default;
const restoreApp = (await import('./budget-restore')).default;

const ownerId = crypto.randomUUID();
const strangerId = crypto.randomUUID();
const mkUser = (id: string, tag: string): IdentityUser => ({
  id,
  email: `budget-export-${tag}@syscd.local`,
  googleSub: null,
  role: 'user',
  status: 'active',
});
let current = mkUser(ownerId, 'owner');

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', current);
  return next();
});
app.route('/export', exportApp);
app.route('/restore', restoreApp);

const budgetA = crypto.randomUUID();
const budgetB = crypto.randomUUID();

const getExport = (bid: string) => app.request(`/export?budget_id=${bid}`);

const seed = {
  groups: ['Everyday', 'Projects'],
  categories: [
    { groupIndex: 0, name: 'Groceries', bundleIndex: 0 },
    { groupIndex: 0, name: 'Utilities', bundleIndex: 0 },
    { groupIndex: 1, name: 'Hidden Cat', hidden: true },
  ],
  bundles: [{ groupIndex: 0, name: 'Home' }],
  accounts: [
    { name: 'Checking Alpha', userId: null },
    { name: 'Savings Beta', userId: null },
  ],
  transactions: [
    { accountIndex: 0, date: '2026-01-05', payee: 'Fresh Market', categoryIndex: 0, memo: 'weekly shop', outflow: 1234, inflow: 0, cleared: 'cleared', flag: 'red', transferPeerIndex: null },
    { accountIndex: 0, date: '2026-01-06', payee: '', categoryIndex: null, memo: '', outflow: 5000, inflow: 0, cleared: 'cleared', flag: '', transferPeerIndex: 2 },
    { accountIndex: 1, date: '2026-01-06', payee: '', categoryIndex: null, memo: '', outflow: 0, inflow: 5000, cleared: 'cleared', flag: '', transferPeerIndex: 1 },
    { accountIndex: 0, date: '2026-01-15', payee: 'Acme Corp', categoryIndex: null, memo: 'salary', outflow: 0, inflow: 90000, cleared: 'reconciled', flag: 'Important', transferPeerIndex: null },
  ],
  assignments: [
    { categoryIndex: 0, month: '2026-01-01', budgeted: 40000 },
    { categoryIndex: 1, month: '2026-01-01', budgeted: -1500 },
  ],
};

beforeAll(async () => {
  if (!dbReady || !pool) return;
  await (await import('../../core/migrate')).runMigrations();
  for (const [id, tag] of [[ownerId, 'owner'], [strangerId, 'stranger']] as const) {
    await pool.query(
      `INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')`,
      [id, mkUser(id, tag).email],
    );
  }
  for (const [id, name] of [[budgetA, 'export-test-a'], [budgetB, 'export-test-b']] as const) {
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [id, name, ownerId]);
  }
  const res = await app.request(`/restore?budget_id=${budgetA}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(seed),
  });
  expect(res.status).toBe(201);
});

afterAll(async () => {
  if (!dbReady || !pool) return;
  await pool.query('DELETE FROM budgets WHERE id = ANY($1)', [[budgetA, budgetB]]);
  await pool.query('DELETE FROM public.users WHERE id = ANY($1)', [[ownerId, strangerId]]);
});

describe.skipIf(!dbReady)('GET /budgets/export', () => {
  test('returns the restore payload for the seeded budget', async () => {
    const res = await getExport(budgetA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof seed & { budget: { name: string } };
    expect(body.budget.name).toBe('export-test-a');
    expect(body.groups).toEqual(seed.groups);
    expect(body.categories.map((c) => c.name)).toEqual(['Groceries', 'Utilities', 'Hidden Cat']);
    expect(body.categories[2].hidden).toBe(true);
    expect(body.accounts.map((a) => a.name)).toEqual(['Checking Alpha', 'Savings Beta']);
    expect(body.transactions).toHaveLength(4);
    const transfer = body.transactions.filter((t) => t.transferPeerIndex !== null);
    expect(transfer).toHaveLength(2);
    expect(transfer.every((t) => t.payee === '')).toBe(true);
    expect(body.transactions.find((t) => t.memo === 'weekly shop')).toMatchObject({
      outflow: 1234,
      inflow: 0,
      flag: 'red',
      payee: 'Fresh Market',
    });
    expect(body.assignments).toHaveLength(2);
  });

  test('includes targets, notes, repeat rules and splits', async () => {
    const cat = await pool!.query<{ id: string }>(
      "SELECT id FROM categories WHERE budget_id = $1 AND name = 'Groceries'",
      [budgetA],
    );
    const acc = await pool!.query<{ id: string }>("SELECT id FROM accounts WHERE budget_id = $1 AND name = 'Checking Alpha'", [budgetA]);
    await pool!.query(
      "INSERT INTO category_targets (budget_id, category_id, kind, amount_cents) VALUES ($1, $2, 'monthly', 25000)",
      [budgetA, cat.rows[0].id],
    );
    await pool!.query("INSERT INTO category_notes (budget_id, category_id, month, note) VALUES ($1, $2, '2026-01-01', 'cat note')", [budgetA, cat.rows[0].id]);
    await pool!.query("INSERT INTO month_notes (budget_id, month, note) VALUES ($1, '2026-01-01', 'month note')", [budgetA]);
    await pool!.query(
      `INSERT INTO txn_repeat_rules (budget_id, account_id, memo, amount, frequency, next_due_date)
       VALUES ($1, $2, 'rent', -100000, 'monthly', '2026-02-01')`,
      [budgetA, acc.rows[0].id],
    );
    const txn = await pool!.query<{ id: string }>("SELECT id FROM transactions WHERE budget_id = $1 AND memo = 'weekly shop'", [budgetA]);
    await pool!.query(
      'INSERT INTO subtransactions (budget_id, transaction_id, amount, memo, category_id) VALUES ($1, $2, -6000, $3, $4), ($1, $2, -6340, $5, NULL)',
      [budgetA, txn.rows[0].id, 'leg one', cat.rows[0].id, 'leg two'],
    );

    const body = (await (await getExport(budgetA)).json()) as {
      category_targets: { kind: string; amount_cents: number }[];
      category_notes: { note: string }[];
      month_notes: { note: string }[];
      repeat_rules: { memo: string; amount_cents: number }[];
      splits: { amount_cents: number }[];
      transactions: { memo: string; outflow: number; categoryIndex: number | null }[];
    };
    expect(body.category_targets).toMatchObject([{ kind: 'monthly', amount_cents: 25000 }]);
    expect(body.category_notes.map((n) => n.note)).toEqual(['cat note']);
    expect(body.month_notes.map((n) => n.note)).toEqual(['month note']);
    expect(body.repeat_rules).toMatchObject([{ memo: 'rent', amount_cents: -10000 }]);
    expect(body.splits.map((s) => s.amount_cents)).toEqual([-634, -600]);
    // split parent: summed amount, no category
    expect(body.transactions.find((t) => t.memo === 'weekly shop')).toMatchObject({ outflow: 1234, categoryIndex: null });
  });

  test('category person is exported (userId) and survives restore into a budget where they are a member', async () => {
    await pool!.query("UPDATE categories SET user_id = $1 WHERE budget_id = $2 AND name = 'Groceries'", [ownerId, budgetA]);
    const body = (await (await getExport(budgetA)).json()) as { categories: { name: string; userId: string | null }[] };
    expect(body.categories.find((c) => c.name === 'Groceries')?.userId).toBe(ownerId);
    expect(body.categories.find((c) => c.name === 'Utilities')?.userId).toBeNull();
  });

  test('round trip: export -> restore into a fresh budget -> export is equal', async () => {
    const first = (await (await getExport(budgetA)).json()) as Record<string, unknown>;
    const res = await app.request(`/restore?budget_id=${budgetB}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(first),
    });
    expect(res.status).toBe(201);
    const second = (await (await getExport(budgetB)).json()) as Record<string, unknown>;
    for (const key of ['groups', 'categories', 'bundles', 'accounts', 'transactions', 'assignments']) {
      expect(second[key]).toEqual(first[key]);
    }
  });

  test('bundles are exported and restored (bundleIndex per category)', async () => {
    const body = (await (await getExport(budgetA)).json()) as {
      bundles: { groupIndex: number; name: string }[];
      categories: { name: string; bundleIndex: number | null }[];
    };
    expect(body.bundles).toEqual([{ groupIndex: 0, name: 'Home' }]);
    expect(body.categories.map((c) => c.bundleIndex)).toEqual([0, 0, null]);
  });

  test('restore rejects a bundleIndex pointing at another group', async () => {
    const bad = { ...seed, categories: seed.categories.map((c, i) => (i === 2 ? { ...c, bundleIndex: 0 } : c)) };
    const res = await app.request(`/restore?budget_id=${budgetB}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);
  });

  test('non-owner gets 404', async () => {
    current = mkUser(strangerId, 'stranger');
    try {
      expect((await getExport(budgetA)).status).toBe(404);
    } finally {
      current = mkUser(ownerId, 'owner');
    }
  });
});
