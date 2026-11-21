/**
 * Tests for server/budget/routes/payees.ts — the payee admin list (GET /) with
 * inferred-category fields, and GET /:id/transactions pagination.
 *
 * Pure-domain logic (inferDefaultCategory) is tested directly; the routes are
 * exercised IN-PROCESS via app.request(). DB tests are gated on Postgres
 * reachability + migrated schema so `bun test` stays green without a live DB.
 * Fixtures self-clean: the test budget is deleted in afterAll and cascades to
 * its categories, payees, accounts, and transactions.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';

import { inferDefaultCategory } from '@shared/domain/payees';
import type { IdentityUser } from '../../user';

// Static imports cannot work here: ../db.ts throws at module load when
// DATABASE_URL is unset, and everything below (pool, the route module)
// transitively requires it. Dynamic import inside try/catch keeps `bun test`
// green for DB-less environments, matching transactions.test.ts.
let pool: Pool | null = null;
let dbReady = false;

try {
  const db = await import('../../core/db');
  pool = db.pool;
  await pool.query('SELECT 1');
  const schema = await pool.query<{ t: string | null }>(
    "select to_regclass('public.transactions')::text as t",
  );
  dbReady = schema.rows[0]?.t != null;
} catch {
  pool = null;
  dbReady = false;
}

const routeApp = (await import('./payees')).default;
const app = new (await import('hono')).Hono();
app.onError((await import('../../core/validate')).httpOnError);

const testUserId = crypto.randomUUID();
const testUser: IdentityUser = {
  id: testUserId,
  email: 'payees-test@syscd.local',
  googleSub: null,
  role: 'user',
  status: 'active',
};
app.use('*', (c, next) => {
  c.set('user', testUser);
  return next();
});
app.route('/', routeApp);

const budgetId = crypto.randomUUID();
const otherBudgetId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const groupId = crypto.randomUUID();
const groceriesId = crypto.randomUUID();
const diningId = crypto.randomUUID();
// Payee with a 2-of-3 majority (Groceries), one all-null payee, and one with a split (no majority).
const majorityPayeeId = crypto.randomUUID();
const uncategorizedPayeeId = crypto.randomUUID();
const splitPayeeId = crypto.randomUUID();

const insertTxn = (payeeId: string, date: string, amount: number, categoryId: string | null) =>
  pool!.query(
    `INSERT INTO transactions (budget_id, account_id, date, amount, payee_id, category_id, memo, cleared)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'cleared')`,
    [budgetId, accountId, date, amount, payeeId, categoryId, 'test txn'],
  );

beforeAll(async () => {
  if (!dbReady || !pool) return;
  await (await import('../../core/migrate')).runMigrations();
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status)
     VALUES ($1, null, $2, 'user', 'active')`,
    [testUserId, testUser.email],
  );
  await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [
    budgetId,
    'payees-test',
    testUserId,
  ]);
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group)
     VALUES ($1, $2, $3, 'checking', 'CASH')`,
    [accountId, budgetId, 'Payees Test Checking'],
  );
  await pool.query('INSERT INTO category_groups (id, budget_id, name) VALUES ($1, $2, $3)', [
    groupId,
    budgetId,
    'Payees Test Group',
  ]);
  await pool.query(
    'INSERT INTO categories (id, budget_id, group_id, name) VALUES ($1, $2, $3, $4)',
    [groceriesId, budgetId, groupId, 'Groceries'],
  );
  await pool.query(
    'INSERT INTO categories (id, budget_id, group_id, name) VALUES ($1, $2, $3, $4)',
    [diningId, budgetId, groupId, 'Dining Out'],
  );
  await pool.query(
    "INSERT INTO payees (id, budget_id, name) VALUES ($1, $2, 'Majority Market'), ($3, $2, 'No Category Cafe'), ($4, $2, 'Split Shop')",
    [majorityPayeeId, budgetId, uncategorizedPayeeId, splitPayeeId],
  );
  // Majority: Groceries holds 2 of the last 3 categorized txns (older 3rd is Groceries too, but outside the window).
  await insertTxn(majorityPayeeId, '2025-01-01', -1000, diningId);
  await insertTxn(majorityPayeeId, '2025-02-01', -2000, groceriesId);
  await insertTxn(majorityPayeeId, '2025-03-01', -3000, groceriesId);
  await insertTxn(majorityPayeeId, '2025-04-01', -4000, groceriesId);
  // All-null history: inference must stay null.
  await insertTxn(uncategorizedPayeeId, '2025-01-01', -5000, null);
  await insertTxn(uncategorizedPayeeId, '2025-02-01', -6000, null);
  // 1-1 split in the last window: no majority, null inference.
  await insertTxn(splitPayeeId, '2025-03-01', -7000, groceriesId);
  await insertTxn(splitPayeeId, '2025-04-01', -8000, diningId);
  // Pagination fixtures on Majority Market: 5 live rows + 1 tombstoned (excluded).
  for (let i = 1; i <= 5; i++) {
    const date = `2025-06-0${i}`;
    await insertTxn(majorityPayeeId, date, -1000 * i, groceriesId);
  }
  await insertTxn(majorityPayeeId, '2025-06-01', -9999, groceriesId);
  await pool!.query('UPDATE transactions SET deleted = true WHERE amount = -9999');
});

afterAll(async () => {
  if (!dbReady || !pool) return;
  await pool.query('DELETE FROM budgets WHERE id = ANY($1)', [[budgetId, otherBudgetId]]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [testUserId]);
});

describe('inferDefaultCategory (pure)', () => {
  test('strict majority wins', () => {
    expect(
      inferDefaultCategory([{ category_id: 'a' }, { category_id: 'a' }, { category_id: 'b' }]),
    ).toBe('a');
  });

  test('no majority (split) returns null', () => {
    expect(inferDefaultCategory([{ category_id: 'a' }, { category_id: 'b' }])).toBeNull();
    expect(inferDefaultCategory([{ category_id: 'a' }, { category_id: 'a' }, { category_id: 'b' }, { category_id: 'b' }])).toBeNull();
  });

  test('null rows carry no signal', () => {
    expect(inferDefaultCategory([{ category_id: null }, { category_id: 'a' }])).toBe('a');
    expect(inferDefaultCategory([{ category_id: null }, { category_id: null }])).toBeNull();
  });

  test('empty history returns null', () => {
    expect(inferDefaultCategory([])).toBeNull();
  });
});

describe('payees routes', () => {
  test('GET / returns inferred_category fields', async () => {
    if (!dbReady) return;
    const res = await app.request(`/?budget_id=${budgetId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      inferred_category_id: string | null;
      inferred_category_name: string | null;
    }[];
    const byId = new Map(body.map((r) => [r.id, r]));
    expect(byId.get(majorityPayeeId)).toMatchObject({
      inferred_category_id: groceriesId,
      inferred_category_name: 'Groceries',
    });
    expect(byId.get(uncategorizedPayeeId)).toMatchObject({
      inferred_category_id: null,
      inferred_category_name: null,
    });
    expect(byId.get(splitPayeeId)).toMatchObject({
      inferred_category_id: null,
      inferred_category_name: null,
    });
  });

  test('GET /:id/transactions returns date-DESC rows with joins and total', async () => {
    if (!dbReady) return;
    const res = await app.request(`/${majorityPayeeId}/transactions?budget_id=${budgetId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: {
        id: string;
        date: string;
        amount: number;
        memo: string | null;
        cleared: string;
        account_id: string;
        account_name: string;
        category_id: string | null;
        category_name: string | null;
        payee_id: string;
      }[];
      total: number;
    };
    expect(body.total).toBe(9);
    expect(body.rows).toHaveLength(9);
    const dates = body.rows.map((r) => r.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const row of body.rows) {
      expect(row.account_id).toBe(accountId);
      expect(row.account_name).toBe('Payees Test Checking');
      // The pre-window January transaction is Dining; everything in the
      // inference window is Groceries.
      expect(row.category_id).toBe(row.date === '2025-01-01' ? diningId : groceriesId);
      expect(row.category_name).toBe(row.date === '2025-01-01' ? 'Dining Out' : 'Groceries');
      expect(row.payee_id).toBe(majorityPayeeId);
      expect(row.cleared).toBe('cleared');
      expect(row.amount).toBeLessThan(0);
    }
  });

  test('pagination limit/offset/total windows correctly', async () => {
    if (!dbReady) return;
    const first = await app.request(`/${majorityPayeeId}/transactions?budget_id=${budgetId}&limit=4`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { rows: { id: string }[]; total: number };
    expect(firstBody.total).toBe(9);
    expect(firstBody.rows).toHaveLength(4);

    const second = await app.request(
      `/${majorityPayeeId}/transactions?budget_id=${budgetId}&limit=4&offset=4`,
    );
    const secondBody = (await second.json()) as { rows: { id: string }[]; total: number };
    expect(secondBody.rows).toHaveLength(4);
    expect(secondBody.rows.map((r) => r.id)).not.toEqual(firstBody.rows.map((r) => r.id));

    const last = await app.request(
      `/${majorityPayeeId}/transactions?budget_id=${budgetId}&limit=4&offset=8`,
    );
    const lastBody = (await last.json()) as { rows: { id: string }[] };
    expect(lastBody.rows).toHaveLength(1);
  });

  test('excludes tombstoned and other-budget payees/transactions', async () => {
    if (!dbReady) return;
    // The -9999 tombstone is excluded from rows AND total (9, not 10).
    const res = await app.request(`/${majorityPayeeId}/transactions?budget_id=${budgetId}`);
    const body = (await res.json()) as { rows: { amount: number }[]; total: number };
    expect(body.rows.every((r) => r.amount !== -9999)).toBe(true);
    // Wrong budget => payee not found (ownership scoping).
    const notFound = await app.request(`/${majorityPayeeId}/transactions?budget_id=${otherBudgetId}`);
    expect(notFound.status).toBe(404);
  });

  test('validates budget_id, payee id, and pagination params', async () => {
    if (!dbReady) return;
    expect((await app.request(`/${majorityPayeeId}/transactions`)).status).toBe(400);
    expect((await app.request(`/not-a-uuid/transactions?budget_id=${budgetId}`)).status).toBe(400);
    const tooBig = await app.request(
      `/${majorityPayeeId}/transactions?budget_id=${budgetId}&limit=201`,
    );
    expect(tooBig.status).toBe(400);
    const negative = await app.request(
      `/${majorityPayeeId}/transactions?budget_id=${budgetId}&offset=-1`,
    );
    expect(negative.status).toBe(400);
    expect((await app.request(`/${crypto.randomUUID()}/transactions?budget_id=${budgetId}`)).status).toBe(404);
  });

  test('defaults limit=50 offset=0', async () => {
    if (!dbReady) return;
    const res = await app.request(`/${majorityPayeeId}/transactions?budget_id=${budgetId}`);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    expect(body.rows).toHaveLength(9);
    expect(body.total).toBe(9);
  });
});

describe('PATCH /:id/name conflicts', () => {
  const rename = (id: string, name: string, budget = budgetId) =>
    app.request(`/${id}/name?budget_id=${budget}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  const nameOf = async (id: string) =>
    (await pool!.query<{ name: string }>('SELECT name FROM payees WHERE id = $1', [id])).rows[0]?.name;
  const mk = async (name: string, extra = '') => {
    const id = crypto.randomUUID();
    await pool!.query(`INSERT INTO payees (id, budget_id, name${extra ? ', deleted' : ''}) VALUES ($1, $2, $3${extra ? ', true' : ''})`, [
      id,
      budgetId,
      name,
    ]);
    return id;
  };

  test('exact duplicate name -> 409 naming the conflict, payee unchanged', async () => {
    if (!dbReady) return;
    await mk('Dup Target');
    const id = await mk('Dup Source');
    const res = await rename(id, 'Dup Target');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('"Dup Target"');
    expect(body.error).toContain('Merge');
    expect(body).toMatchObject({ code: 'payee_name_exists', params: { name: 'Dup Target' } });
    expect(await nameOf(id)).toBe('Dup Source');
  });

  test('case-only difference from another payee -> 409', async () => {
    if (!dbReady) return;
    await mk('iFood Other');
    const id = await mk('Case Source');
    const res = await rename(id, 'ifood other');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('"iFood Other"');
    expect(await nameOf(id)).toBe('Case Source');
  });

  test('case-only rename of the same payee still works', async () => {
    if (!dbReady) return;
    const id = await mk('ifood');
    expect((await rename(id, 'iFood')).status).toBe(204);
    expect(await nameOf(id)).toBe('iFood');
  });

  test('name held by a deleted payee -> 409 (constraint covers tombstones)', async () => {
    if (!dbReady) return;
    await mk('Ghost Payee', 'deleted');
    const id = await mk('Ghost Source');
    const res = await rename(id, 'Ghost Payee');
    expect(res.status).toBe(409);
    expect(((await res.clone().json()) as { error: string }).error).toContain('deleted payee');
    expect(await res.json()).toMatchObject({ code: 'payee_name_deleted_exists', params: { name: 'Ghost Payee' } });
    expect(await nameOf(id)).toBe('Ghost Source');
  });

  test('concurrent renames to one name: one 204, the rest 409, never 500', async () => {
    if (!dbReady) return;
    const ids = await Promise.all([mk('Race A'), mk('Race B'), mk('Race C')]);
    const statuses = (await Promise.all(ids.map((id) => rename(id, 'Race Winner')))).map((r) => r.status);
    expect(statuses.filter((s) => s === 204)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);
  });

  test('unknown payee still 404; unique name still renames', async () => {
    if (!dbReady) return;
    expect((await rename(crypto.randomUUID(), 'Whatever')).status).toBe(404);
    const id = await mk('Plain Old');
    expect((await rename(id, 'Plain New')).status).toBe(204);
    expect(await nameOf(id)).toBe('Plain New');
  });
});
