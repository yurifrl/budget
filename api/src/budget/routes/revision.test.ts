/**
 * Tests for the per-budget change revision (migration 0033 triggers +
 * GET /budget-revision). The revision must move on ANY write to a budget's
 * data and stay put for other budgets. Routes run in-process via app.request().
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';

import type { IdentityUser } from '../../user';

let pool: Pool | null = null;
let dbReady = false;
try {
  pool = (await import('../../core/db')).pool;
  await pool.query('SELECT 1');
  dbReady = (await pool.query("select to_regclass('public.transactions')::text as t")).rows[0]?.t != null;
} catch {
  pool = null;
  dbReady = false;
}

const { Hono } = await import('hono');
const app = new Hono();
app.onError((await import('../../core/validate')).httpOnError);

const userId = crypto.randomUUID();
const user: IdentityUser = { id: userId, email: 'revision-test@syscd.local', googleSub: null, role: 'user', status: 'active' };
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/budget-revision', (await import('./revision')).default);
app.route('/transactions', (await import('./transactions')).default);
app.route('/assignments', (await import('./assignments')).default);
app.route('/accounts', (await import('./accounts')).default);

const budgetId = crypto.randomUUID();
const otherBudgetId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const categoryId = crypto.randomUUID();
const groupId = crypto.randomUUID();

const json = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const revisionOf = async (id: string): Promise<number> => {
  const res = await json('GET', `/budget-revision?budget_id=${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { revision: number }).revision;
};

beforeAll(async () => {
  if (!dbReady || !pool) return;
  await (await import('../../core/migrate')).runMigrations();
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')`,
    [userId, user.email],
  );
  for (const id of [budgetId, otherBudgetId]) {
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [id, 'revision-test', userId]);
  }
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group) VALUES ($1, $2, 'Checking', 'checking', 'CASH')`,
    [accountId, budgetId],
  );
  await pool.query(`INSERT INTO category_groups (id, budget_id, name) VALUES ($1, $2, 'G')`, [groupId, budgetId]);
  await pool.query(`INSERT INTO categories (id, budget_id, group_id, name) VALUES ($1, $2, $3, 'Food')`, [
    categoryId,
    budgetId,
    groupId,
  ]);
});

afterAll(async () => {
  if (!dbReady || !pool) return;
  await pool.query('DELETE FROM budgets WHERE id = ANY($1)', [[budgetId, otherBudgetId]]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
});

describe.skipIf(!dbReady)('budget revision', () => {
  test('unknown or foreign budget is 404', async () => {
    expect((await json('GET', `/budget-revision?budget_id=${crypto.randomUUID()}`)).status).toBe(404);
  });

  test('is stable without writes', async () => {
    expect(await revisionOf(budgetId)).toBe(await revisionOf(budgetId));
  });

  test('bumps on transaction insert, not for another budget', async () => {
    const before = await revisionOf(budgetId);
    const otherBefore = await revisionOf(otherBudgetId);
    const res = await json('POST', `/transactions?budget_id=${budgetId}`, {
      budget_id: budgetId,
      txn: {
        account_id: accountId, date: '2025-03-01', payee: 'Cafe', category_id: null, memo: null,
        outflow: 5000, inflow: 0, cleared: 'uncleared', approved: true, flag: null, repeat: 'never',
      },
    });
    expect(res.status).toBe(201);
    expect(await revisionOf(budgetId)).toBeGreaterThan(before);
    expect(await revisionOf(otherBudgetId)).toBe(otherBefore);
  });

  test('a bulk import bumps', async () => {
    const before = await revisionOf(budgetId);
    const txns = Array.from({ length: 50 }, (_, i) => ({
      date: '2025-04-01', payee: `P${i}`, category_id: null, memo: null,
      outflow: (100 + i) * 10, inflow: 0, import_id: `rev-test-${i}`,
    }));
    const res = await json('POST', `/transactions/bulk?budget_id=${budgetId}`, { budget_id: budgetId, account_id: accountId, txns });
    expect(res.status).toBeLessThan(300);
    const after = await revisionOf(budgetId);
    expect(after).toBeGreaterThan(before);
  });

  test('one multi-row statement bumps exactly once (statement-level trigger)', async () => {
    const before = await revisionOf(budgetId);
    await pool!.query(
      `INSERT INTO payees (budget_id, name) SELECT $1, 'bulk-' || g FROM generate_series(1, 200) g`,
      [budgetId],
    );
    expect(await revisionOf(budgetId)).toBe(before + 1);
  });

  test('a rolled-back write does not bump; a multi-statement transaction bumps once', async () => {
    const before = await revisionOf(budgetId);
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO payees (budget_id, name) VALUES ($1, 'rolled-back')`, [budgetId]);
      await client.query('ROLLBACK');
      expect(await revisionOf(budgetId)).toBe(before);
      await client.query('BEGIN');
      await client.query(`INSERT INTO payees (budget_id, name) VALUES ($1, 'tx-a')`, [budgetId]);
      await client.query(`INSERT INTO payees (budget_id, name) VALUES ($1, 'tx-b')`, [budgetId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await revisionOf(budgetId)).toBe(before + 1);
  });

  test('bumps on assignment set', async () => {
    const before = await revisionOf(budgetId);
    const res = await json('POST', `/assignments?budget_id=${budgetId}`, {
      budget_id: budgetId, month: '2025-03-01', category_id: categoryId, budgeted: 10000,
    });
    expect(res.status).toBeLessThan(300);
    expect(await revisionOf(budgetId)).toBeGreaterThan(before);
  });

  test('bumps on account update', async () => {
    const before = await revisionOf(budgetId);
    const res = await json('PATCH', `/accounts/${accountId}?budget_id=${budgetId}`, { budget_id: budgetId, name: 'Renamed' });
    expect(res.status).toBeLessThan(300);
    expect(await revisionOf(budgetId)).toBeGreaterThan(before);
  });

  test('bumps on a raw write from outside any route (the trigger, not handler code)', async () => {
    const before = await revisionOf(budgetId);
    await pool!.query('DELETE FROM categories WHERE id = $1', [categoryId]);
    expect(await revisionOf(budgetId)).toBeGreaterThan(before);
  });
});
