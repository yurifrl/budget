/**
 * Tests for server/budget/routes/transactions.ts — POST /bulk statement import.
 *
 * Route exercised IN-PROCESS via app.request(). DB tests are gated on
 * Postgres reachability + migrated schema so `bun test` stays green without
 * a live DB. Fixtures self-clean: the test budget is deleted in afterAll and
 * cascades to its account, payees, and transactions.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

import type { IdentityUser } from '../../user';

// Static imports cannot work here: ../db.ts throws at module load when
// DATABASE_URL is unset, and everything below (pool, migrate, the route
// module) transitively requires it. Dynamic import inside try/catch keeps
// `bun test` green for DB-less environments, matching ourtube.test.ts.
let pool: Pool | null = null;
let dbReady = false;

try {
  const db = await import('../../core/db');
  pool = db.pool;
  await pool.query('SELECT 1');
  const schema = await pool.query<{ t: string | null }>(
    "select to_regclass('public.transactions')::text as t",
  );
  // regclass::text omits the schema when it is on search_path ("transactions"
  // vs "public.transactions"), so check existence, not the exact name.
  dbReady = schema.rows[0]?.t != null;
} catch {
  pool = null;
  dbReady = false;
}

// The route module is mounted under index.ts's app.onError(httpOnError) in
// production; mirror that here so HttpError statuses surface in-process.
const routeApp = (await import('./transactions')).default;
const app = new (await import('hono')).Hono();
app.onError((await import('../../core/validate')).httpOnError);

// Phase 2 scoping (USER-05): the route runs behind requireUser in production.
// Mirror that here with a stubbed non-admin identity backed by a real users
// row (inserted in beforeAll) so ownership checks resolve.
const testUserId = crypto.randomUUID();
const testUser: IdentityUser = {
  id: testUserId,
  email: 'bulk-import-test@syscd.local',
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
const accountId = crypto.randomUUID();

interface BulkRow {
  date: string;
  payee: string;
  memo: string;
  outflow_cents: number;
  inflow_cents: number;
  category_id: string | null;
  import_id?: string;
}

/** Two identical id-less rows (same amount+date) plus one explicit import_id. */
const statementRows: BulkRow[] = [
  { date: '2025-03-01', payee: 'Nubank', memo: '', outflow_cents: 1234, inflow_cents: 0, category_id: null },
  { date: '2025-03-01', payee: 'Nubank', memo: '', outflow_cents: 1234, inflow_cents: 0, category_id: null },
  { date: '2025-03-02', payee: 'Salary', memo: '', outflow_cents: 0, inflow_cents: 50000, category_id: null, import_id: 'test-salary-0001' },
];

const postBulk = (txns: unknown[], accountIdOverride?: string) =>
  app.request('/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      budget_id: budgetId,
      account_id: accountIdOverride ?? accountId,
      txns,
    }),
  });

beforeAll(async () => {
  if (!dbReady || !pool) return;
  await (await import('../../core/migrate')).runMigrations();
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status)
     VALUES ($1, null, $2, 'user', 'active')`,
    [testUserId, testUser.email],
  );
  await pool.query(
    'INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)',
    [budgetId, 'bulk-import-test', testUserId],
  );
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group)
     VALUES ($1, $2, $3, 'checking', 'CASH')`,
    [accountId, budgetId, 'Bulk Test Checking'],
  );
});

afterAll(async () => {
  if (!dbReady || !pool) return;
  await pool.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [testUserId]);
});

describe('transactions routes', () => {
  test('exports a Hono app', () => {
    expect(app).toBeDefined();
    expect(typeof app.request).toBe('function');
  });

  test.skipIf(!dbReady)('imports a batch once, dedupes re-import, applies balance exactly once', async () => {
    const first = await postBulk(statementRows);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ imported: 3, duplicates: 0 });

    // One server-computed uncleared delta: (50000 - 1234 - 1234) cents.
    const acc = await pool!.query<{ uncleared_balance: string; cleared_balance: string }>(
      'SELECT uncleared_balance, cleared_balance FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(Number(acc.rows[0].uncleared_balance)).toBe((50000 - 1234 - 1234) * 10);
    expect(Number(acc.rows[0].cleared_balance)).toBe(0);

    // Re-import the same file: everything is a duplicate, balance untouched.
    const again = await postBulk(statementRows);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ imported: 0, duplicates: 3 });
    const acc2 = await pool!.query<{ uncleared_balance: string }>(
      'SELECT uncleared_balance FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(Number(acc2.rows[0].uncleared_balance)).toBe((50000 - 1234 - 1234) * 10);

    // Partial re-import: dup row skipped by occurrence rule, new row inserted.
    const partial = await postBulk([
      statementRows[0],
      { date: '2025-03-05', payee: 'New Store', memo: '', outflow_cents: 999, inflow_cents: 0, category_id: null },
    ]);
    expect(await partial.json()).toEqual({ imported: 1, duplicates: 1 });

    // Imported rows are uncleared + unapproved, with YNAB-style import ids.
    const rows = await pool!.query<{ import_id: string; cleared: string; approved: boolean }>(
      'SELECT import_id, cleared, approved FROM transactions WHERE account_id = $1 ORDER BY date',
      [accountId],
    );
    expect(rows.rows.every((r) => r.cleared === 'uncleared' && r.approved === false)).toBe(true);
    const payees = await pool!.query<{ id: string; name: string }>(
      'SELECT id, name FROM payees WHERE budget_id = $1',
      [budgetId],
    );
    const nubankId = payees.rows.find((p) => p.name === 'Nubank')!.id;
    expect(rows.rows.map((r) => r.import_id)).toContain(`YNAB:-12340:2025-03-01:${nubankId}:1`);
    expect(rows.rows.map((r) => r.import_id)).toContain(`YNAB:-12340:2025-03-01:${nubankId}:2`);
  });

  test.skipIf(!dbReady)('same day+amount, different payees are distinct rows', async () => {
    // The old key (date+amount) made a second vendor's row look like a
    // re-import of the first: Nubank 7.00 exists, then Outro 7.00 same day
    // arrived with occurrence 1 <= 1 and was swallowed. Second post must be
    // {imported: 1, duplicates: 1} — Alpha re-imported, Beta inserted.
    const vendorAccountId = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO accounts (id, budget_id, name, type, account_group)
       VALUES ($1, $2, 'Vendor Test Checking', 'checking', 'CASH')`,
      [vendorAccountId, budgetId],
    );
    const rows = [
      { date: '2025-04-01', payee: 'Alpha Market', memo: '', outflow_cents: 700, inflow_cents: 0, category_id: null },
      { date: '2025-04-01', payee: 'Beta Market', memo: '', outflow_cents: 700, inflow_cents: 0, category_id: null },
    ];
    const first = await postBulk(rows, vendorAccountId);
    expect(await first.json()).toEqual({ imported: 2, duplicates: 0 });
    const again = await postBulk(rows, vendorAccountId);
    expect(await again.json()).toEqual({ imported: 0, duplicates: 2 });

    // Generated ids carry the resolved payee uuid as the key component.
    const payees = await pool!.query<{ id: string; name: string }>(
      "SELECT id, name FROM payees WHERE budget_id = $1 AND name IN ('Alpha Market', 'Beta Market')",
      [budgetId],
    );
    const ids = (
      await pool!.query<{ import_id: string }>(
        'SELECT import_id FROM transactions WHERE account_id = $1',
        [vendorAccountId],
      )
    ).rows.map((r) => r.import_id);
    const alphaId = payees.rows.find((p) => p.name === 'Alpha Market')!.id;
    const betaId = payees.rows.find((p) => p.name === 'Beta Market')!.id;
    expect(ids).toContain(`YNAB:-7000:2025-04-01:${alphaId}:1`);
    expect(ids).toContain(`YNAB:-7000:2025-04-01:${betaId}:1`);
  });

  test.skipIf(!dbReady)('legacy generated ids are rewritten to include the payee', async () => {
    // Seed two legacy-format rows (payee-bound and unbound) and re-run the
    // 0015 migration's own SQL — idempotent, so running it here is safe.
    const payeeId = crypto.randomUUID();
    const boundId = crypto.randomUUID();
    const blankId = crypto.randomUUID();
    await pool!.query(
      'INSERT INTO payees (id, budget_id, name) VALUES ($1, $2, $3)',
      [payeeId, budgetId, 'Legacy Vendor'],
    );
    await pool!.query(
      `INSERT INTO transactions (id, budget_id, account_id, date, amount, payee_id, memo, cleared, approved, repeat, import_id)
       VALUES ($1, $2, $3, '2025-05-01', -5000, $4, '', 'uncleared', false, 'never', 'YNAB:-5000:2025-05-01:3')`,
      [boundId, budgetId, accountId, payeeId],
    );
    await pool!.query(
      `INSERT INTO transactions (id, budget_id, account_id, date, amount, payee_id, memo, cleared, approved, repeat, import_id)
       VALUES ($1, $2, $3, '2025-05-02', -6000, null, '', 'uncleared', false, 'never', 'YNAB:-6000:2025-05-02:2')`,
      [blankId, budgetId, accountId],
    );
    const sql = readFileSync(join(import.meta.dir, '../../../db/migrations/0015_import_key_payee.sql'), 'utf8');
    await pool!.query(sql);
    const got = await pool!.query<{ id: string; import_id: string }>(
      'SELECT id, import_id FROM transactions WHERE id = ANY($1::uuid[])',
      [[boundId, blankId]],
    );
    expect(got.rows.find((r) => r.id === boundId)!.import_id).toBe(`YNAB:-5000:2025-05-01:${payeeId}:3`);
    expect(got.rows.find((r) => r.id === blankId)!.import_id).toBe('YNAB:-6000:2025-05-02:-:2');
  });

  test.skipIf(!dbReady)('rejects a batch for an account outside the budget', async () => {
    const res = await postBulk([statementRows[0]], crypto.randomUUID());
    expect(res.status).toBe(400);
  });

  test.skipIf(!dbReady)('rejects rows that are both inflow and outflow', async () => {
    const res = await postBulk([
      { ...statementRows[0], outflow_cents: 100, inflow_cents: 100 },
    ]);
    expect(res.status).toBe(400);
  });

  // --- split transactions (syscd-app-rlt) -----------------------------------
  const splitBudgetId = crypto.randomUUID();
  const splitAccountId = crypto.randomUUID();

  const postTxn = (body: unknown) =>
    app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    if (!dbReady || !pool) return;
    await pool.query(
      'INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)',
      [splitBudgetId, 'split-test', testUserId],
    );
    await pool.query(
      `INSERT INTO accounts (id, budget_id, name, type, account_group)
       VALUES ($1, $2, $3, 'checking', 'CASH')`,
      [splitAccountId, splitBudgetId, 'Split Test Checking'],
    );
    await pool.query(
      "INSERT INTO category_groups (id, budget_id, name) VALUES ($1, $2, 'Split Group')",
      [crypto.randomUUID(), splitBudgetId],
    );
    await pool.query(
      `INSERT INTO categories (id, budget_id, group_id, name)
       SELECT $1, $2, g.id, $3 FROM category_groups g WHERE g.budget_id = $2 LIMIT 1`,
      [crypto.randomUUID(), splitBudgetId, 'Split Cat A'],
    );
    await pool.query(
      `INSERT INTO categories (id, budget_id, group_id, name)
       SELECT $1, $2, g.id, $3 FROM category_groups g WHERE g.budget_id = $2 LIMIT 1`,
      [crypto.randomUUID(), splitBudgetId, 'Split Cat B'],
    );
  });

  afterAll(async () => {
    if (!dbReady || !pool) return;
    await pool.query('DELETE FROM budgets WHERE id = $1', [splitBudgetId]);
  });

  test.skipIf(!dbReady)('creates a split: parent category NULL, legs stored, balance moves once', async () => {
    const cats = await pool!.query<{ id: string; name: string }>(
      'SELECT id, name FROM categories WHERE budget_id = $1 ORDER BY name',
      [splitBudgetId],
    );
    const catA = cats.rows.find((c) => c.name === 'Split Cat A')!.id;
    const catB = cats.rows.find((c) => c.name === 'Split Cat B')!.id;

    const res = await postTxn({
      budget_id: splitBudgetId,
      txn: {
        account_id: splitAccountId,
        date: '2025-06-01',
        payee: 'Split Grocer',
        category_id: null,
        memo: '',
        outflow_cents: 3000,
        inflow_cents: 0,
        cleared: 'uncleared',
        approved: true,
        flag: null,
        repeat: '',
      },
      subtransactions: [
        { category_id: catA, memo: 'produce', outflow_cents: 2000, inflow_cents: 0 },
        { category_id: catB, memo: 'cleaning', outflow_cents: 1000, inflow_cents: 0 },
      ],
      deltas: [{ account_id: splitAccountId, cleared_delta: 0, uncleared_delta: -3000 }],
    });
    expect(res.status).toBe(201);
    const txnId = (await res.json() as { id: string }).id;

    // Parent carries the split total and NULL category; legs stored with cents->milli.
    const parent = await pool!.query<{ amount: string; category_id: string | null }>(
      'SELECT amount, category_id FROM transactions WHERE id = $1',
      [txnId],
    );
    expect(Number(parent.rows[0].amount)).toBe(-30000);
    expect(parent.rows[0].category_id).toBeNull();

    const legs = await pool!.query<{ amount: string; memo: string | null; category_id: string }>(
      'SELECT amount, memo, category_id FROM subtransactions WHERE transaction_id = $1 ORDER BY memo',
      [txnId],
    );
    expect(legs.rows).toHaveLength(2);
    const byMemo = new Map(legs.rows.map((r) => [r.memo, Number(r.amount)]));
    expect(byMemo.get('cleaning')).toBe(-10000);
    expect(byMemo.get('produce')).toBe(-20000);

    // GET rides the legs along.
    const get = await app.request(`/?budget_id=${splitBudgetId}`);
    expect(get.status).toBe(200);
    const list = (await get.json()) as { id: string; subtransactions: { amount: number }[] }[];
    const splitRow = list.find((t) => t.id === txnId)!;
    expect(splitRow.subtransactions).toHaveLength(2);
  });

  test.skipIf(!dbReady)('rejects a split that also carries a category_id', async () => {
    const cats = await pool!.query<{ id: string }>(
      'SELECT id FROM categories WHERE budget_id = $1 ORDER BY name LIMIT 1',
      [splitBudgetId],
    );
    const res = await postTxn({
      budget_id: splitBudgetId,
      txn: {
        account_id: splitAccountId,
        date: '2025-06-02',
        payee: 'Bad Split',
        category_id: cats.rows[0].id,
        memo: '',
        outflow_cents: 500,
        inflow_cents: 0,
        cleared: 'uncleared',
        approved: true,
        flag: null,
        repeat: '',
      },
      subtransactions: [
        { category_id: cats.rows[0].id, memo: null, outflow_cents: 500, inflow_cents: 0 },
      ],
      deltas: [],
    });
    expect(res.status).toBe(400);
  });

  test.skipIf(!dbReady)('PATCH replaces the leg list and un-splits to a single category', async () => {
    const cats = await pool!.query<{ id: string; name: string }>(
      'SELECT id, name FROM categories WHERE budget_id = $1 ORDER BY name',
      [splitBudgetId],
    );
    const catA = cats.rows.find((c) => c.name === 'Split Cat A')!.id;
    const catB = cats.rows.find((c) => c.name === 'Split Cat B')!.id;

    // Create a split, then patch it to a single-category (un-split) txn.
    const created = await postTxn({
      budget_id: splitBudgetId,
      txn: {
        account_id: splitAccountId,
        date: '2025-06-03',
        payee: 'Patch Split',
        category_id: null,
        memo: '',
        outflow_cents: 1000,
        inflow_cents: 0,
        cleared: 'uncleared',
        approved: true,
        flag: null,
        repeat: '',
      },
      subtransactions: [
        { category_id: catA, memo: null, outflow_cents: 400, inflow_cents: 0 },
        { category_id: catB, memo: null, outflow_cents: 600, inflow_cents: 0 },
      ],
      deltas: [{ account_id: splitAccountId, cleared_delta: 0, uncleared_delta: -1000 }],
    });
    const txnId = (await created.json() as { id: string }).id;

    // Replacing the leg list with an empty one (un-split) clears the stale NULL
    // category so the row is not silently uncategorized.
    // The transactions routes are mounted at /transactions in the real app;
    // driving the module app directly, paths are relative to the mount.
    const patchRes = await app.request(`/${txnId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        budget_id: splitBudgetId,
        patch: { category_id: catB, outflow_cents: 1000, inflow_cents: 0 },
        deltas: [],
        subtransactions: [],
      }),
    });
    expect(patchRes.status).toBe(204);

    const after = await pool!.query<{ category_id: string | null }>(
      'SELECT category_id FROM transactions WHERE id = $1',
      [txnId],
    );
    expect(after.rows[0].category_id).toBe(catB);
    // Legs soft-delete (audit trail); none may remain live.
    const legs = await pool!.query(
      'SELECT deleted FROM subtransactions WHERE transaction_id = $1',
      [txnId],
    );
    expect(legs.rows.length).toBeGreaterThan(0);
    expect(legs.rows.every((r) => r.deleted)).toBe(true);
  });
  test.skipIf(!dbReady)('GET / returns payee_name for transfer payees (GET /payees omits them)', async () => {
    const otherAccountId = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO accounts (id, budget_id, name, type, account_group)
       VALUES ($1, $2, 'Transfer Peer', 'checking', 'CASH')`,
      [otherAccountId, budgetId],
    );
    const payee = await pool!.query<{ id: string }>(
      `INSERT INTO payees (budget_id, name, transfer_account_id)
       VALUES ($1, 'Transfer : Transfer Peer', $2) RETURNING id`,
      [budgetId, otherAccountId],
    );
    const txnId = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO transactions (id, budget_id, account_id, date, amount, payee_id, cleared, approved, repeat, deleted)
       VALUES ($1, $2, $3, '2026-01-01', -1000, $4, 'cleared', true, 'never', false)`,
      [txnId, budgetId, accountId, payee.rows[0].id],
    );
    const res = await app.request(`/?budget_id=${budgetId}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; payee_id: string | null; payee_name: string | null }[];
    expect(rows.find((r) => r.id === txnId)?.payee_name).toBe('Transfer : Transfer Peer');
    // Rows without a payee carry a null name, not a missing row.
    expect(rows.every((r) => r.payee_id !== null || r.payee_name === null)).toBe(true);
  });
});
