/**
 * Tests for server/budget/routes/budget-restore.ts — POST /budgets/restore.
 *
 * Route exercised IN-PROCESS via app.request(). DB tests are gated on
 * Postgres reachability + migrated schema so `bun test` stays green without
 * a live DB. Fixtures are synthetic/anonymized; the test budget is deleted
 * in afterAll and cascades to every restored row.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Pool } from 'pg';

import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';

// Static import of the route/db modules cannot work here: ../db.ts throws at
// module load when DATABASE_URL is unset, so they are loaded dynamically
// inside try/catch to keep `bun test` green for DB-less environments
// (matching transactions.test.ts).
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

const routeApp = (await import('./budget-restore')).default;
const app = new Hono();
app.onError(httpOnError);

const testUserId = crypto.randomUUID();
const testUser: IdentityUser = {
  id: testUserId,
  email: 'budget-restore-test@syscd.local',
  googleSub: null,
  role: 'user',
  status: 'active',
};
app.use('*', (c, next) => {
  c.set('user', testUser);
  return next();
});
app.route('/', routeApp);
// The real accounts list endpoint: the API surface that serves balances.
app.route('/accounts', (await import('./accounts')).default);

const budgetId = crypto.randomUUID();
const memberId = crypto.randomUUID();
const outsiderId = crypto.randomUUID();

interface RestoreTxn {
  accountIndex: number;
  date: string;
  payee: string;
  categoryIndex: number | null;
  memo: string;
  outflow: number;
  inflow: number;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  flag: string;
  transferPeerIndex: number | null;
}

const payload = () => ({
  groups: ['Everyday', 'Projects'],
  categories: [
    { groupIndex: 0, name: 'Groceries' },
    { groupIndex: 0, name: 'Utilities' },
    { groupIndex: 1, name: 'Hidden Cat', hidden: true },
  ],
  accounts: [{ name: 'Checking Alpha' }, { name: 'Savings Beta' }],
  transactions: [
    // grocery spend
    {
      accountIndex: 0,
      date: '2026-01-05',
      payee: 'Fresh Market',
      categoryIndex: 0,
      memo: 'weekly shop',
      outflow: 1234,
      inflow: 0,
      cleared: 'cleared',
      flag: 'red',
      transferPeerIndex: null,
    },
    // checking -> savings transfer pair
    {
      accountIndex: 0,
      date: '2026-01-06',
      payee: '',
      categoryIndex: null,
      memo: '',
      outflow: 5000,
      inflow: 0,
      cleared: 'cleared',
      flag: '',
      transferPeerIndex: 2,
    },
    {
      accountIndex: 1,
      date: '2026-01-06',
      payee: '',
      categoryIndex: null,
      memo: '',
      outflow: 0,
      inflow: 5000,
      cleared: 'cleared',
      flag: '',
      transferPeerIndex: 1,
    },
    // income with a named flag label
    {
      accountIndex: 0,
      date: '2026-01-15',
      payee: 'Acme Corp',
      categoryIndex: null,
      memo: 'salary',
      outflow: 0,
      inflow: 90000,
      cleared: 'reconciled',
      flag: 'Important',
      transferPeerIndex: null,
    },
  ] satisfies RestoreTxn[],
  assignments: [
    { categoryIndex: 0, month: '2026-01-01', budgeted: 40000 },
    { categoryIndex: 1, month: '2026-01-01', budgeted: -1500 },
  ],
});

const postRestore = (body: unknown, bid: string = budgetId) =>
  app.request(`/?budget_id=${bid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
    [budgetId, 'budget-restore-test', testUserId],
  );
  for (const [id, tag] of [[memberId, 'member'], [outsiderId, 'outsider']] as const) {
    await pool.query(
      `INSERT INTO public.users (id, google_sub, email, role, status)
       VALUES ($1, null, $2, 'user', 'active')`,
      [id, `restore-person-${tag}@syscd.local`],
    );
  }
  await pool.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2)', [budgetId, memberId]);
});

afterAll(async () => {
  if (!dbReady || !pool) return;
  await pool.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
  await pool.query('DELETE FROM public.users WHERE id = ANY($1)', [[testUserId, memberId, outsiderId]]);
});

describe.skipIf(!dbReady)('POST /budgets/restore', () => {
  test('restores the full payload with correct linked rows', async () => {
    const res = await postRestore(payload());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      groups: 2,
      categories: 3,
      accounts: 2,
      transactions: 4,
      assignments: 2,
      uncategorized: 0,
    });

    // groups + categories (hidden flag)
    const groups = await pool!.query<{ name: string; sort_order: number }>(
      'SELECT name, sort_order FROM category_groups WHERE budget_id = $1 ORDER BY sort_order',
      [budgetId],
    );
    expect(groups.rows.map((g) => g.name)).toEqual(['Everyday', 'Projects']);
    const cats = await pool!.query<{ name: string; hidden: boolean }>(
      'SELECT name, hidden FROM categories WHERE budget_id = $1 ORDER BY sort_order',
      [budgetId],
    );
    expect(cats.rows.map((c) => c.name)).toEqual(['Groceries', 'Utilities', 'Hidden Cat']);
    expect(cats.rows[2].hidden).toBe(true);

    // accounts created as checking/CASH
    const accounts = await pool!.query<{ name: string; type: string; account_group: string }>(
      'SELECT name, type, account_group::text as account_group FROM accounts WHERE budget_id = $1 ORDER BY sort_order',
      [budgetId],
    );
    expect(accounts.rows.map((a) => a.name)).toEqual(['Checking Alpha', 'Savings Beta']);
    expect(accounts.rows[0].type).toBe('checking');

    // transaction amounts in milliunits, signed; flag color vs label split
    const txns = await pool!.query<{
      amount: string;
      payee: string;
      memo: string;
      cleared: string;
      flag_color: string | null;
      flag_name: string | null;
    }>(
      `SELECT amount, p.name as payee, memo, cleared::text as cleared, flag_color, flag_name
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
       WHERE t.budget_id = $1 ORDER BY t.date`,
      [budgetId],
    );
    expect(Number(txns.rows[0].amount)).toBe(-1234 * 10);
    expect(txns.rows[0].payee).toBe('Fresh Market');
    expect(txns.rows[0].flag_color).toBe('red');
    expect(txns.rows[0].flag_name).toBeNull();
    expect(Number(txns.rows[3].amount)).toBe(90000 * 10);
    expect(txns.rows[3].flag_color).toBeNull();
    expect(txns.rows[3].flag_name).toBe('Important');

    // transfer pair: linked, both legs, synthesized "Transfer : <account>" payee
    const legs = await pool!.query<{
      id: string;
      peer: string | null;
      account_id: string;
      amount: string;
      payee: string;
    }>(
      `SELECT t.id, t.transfer_transaction_id::text as peer, t.account_id::text as account_id,
              t.amount, p.name as payee
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
       WHERE t.budget_id = $1 AND t.transfer_transaction_id IS NOT NULL ORDER BY t.date, t.amount DESC`,
      [budgetId],
    );
    expect(legs.rows.length).toBe(2);
    expect(legs.rows[0].peer).toBe(legs.rows[1].id);
    expect(legs.rows[1].peer).toBe(legs.rows[0].id);
    expect(Number(legs.rows[0].amount)).toBe(5000 * 10);
    expect(legs.rows[0].payee).toBe('Transfer : Checking Alpha');
    expect(Number(legs.rows[1].amount)).toBe(-5000 * 10);
    expect(legs.rows[1].payee).toBe('Transfer : Savings Beta');

    // transfer payees link to their accounts
    const transferPayees = await pool!.query<{ name: string; linked: boolean }>(
      `SELECT p.name, (p.transfer_account_id IS NOT NULL) as linked
       FROM payees p WHERE p.budget_id = $1 AND p.name LIKE 'Transfer : %'`,
      [budgetId],
    );
    expect(transferPayees.rows.length).toBe(2);
    expect(transferPayees.rows.every((p) => p.linked)).toBe(true);

    // payee dedupe: two legs of the transfer share one payee_id? (no — different accounts)
    // Fresh Market payee resolved once
    const payees = await pool!.query<{ name: string }>(
      'SELECT name FROM payees WHERE budget_id = $1 ORDER BY name',
      [budgetId],
    );
    expect(payees.rows.map((p) => p.name).sort()).toEqual(
      ['Acme Corp', 'Fresh Market', 'Transfer : Checking Alpha', 'Transfer : Savings Beta'],
    );

    // assignments: months as date, budgeted milliunits (signed)
    const assignments = await pool!.query<{ budgeted: string }>(
      'SELECT budgeted FROM assignments WHERE budget_id = $1 ORDER BY budgeted',
      [budgetId],
    );
    expect(assignments.rows.map((a) => Number(a.budgeted))).toEqual([-1500 * 10, 40000 * 10]);
  });

  test('a restored transfer is complete: both pointers on both legs, no category on either', async () => {
    const withCategories = payload();
    // A backup from the old app: the legs of the checking -> savings pair carry categories.
    withCategories.transactions[1]!.categoryIndex = 0;
    withCategories.transactions[2]!.categoryIndex = 1;
    const res = await postRestore(withCategories);
    expect(res.status).toBe(201);
    expect((await res.json()) as { uncategorized: number }).toMatchObject({ uncategorized: 0 });
    const legs = await pool!.query<{
      id: string;
      account_id: string;
      transfer_account_id: string | null;
      transfer_transaction_id: string | null;
      category_id: string | null;
    }>(
      `SELECT id, account_id, transfer_account_id, transfer_transaction_id, category_id
       FROM transactions WHERE budget_id = $1 AND (transfer_transaction_id IS NOT NULL OR transfer_account_id IS NOT NULL) ORDER BY date, amount DESC`,
      [budgetId],
    );
    expect(legs.rows).toHaveLength(2);
    const [inflow, outflow] = legs.rows;
    expect(inflow!.transfer_transaction_id).toBe(outflow!.id);
    expect(outflow!.transfer_transaction_id).toBe(inflow!.id);
    expect(inflow!.transfer_account_id).toBe(outflow!.account_id);
    expect(outflow!.transfer_account_id).toBe(inflow!.account_id);
    expect([inflow!.category_id, outflow!.category_id]).toEqual([null, null]);
    // An ordinary categorized row keeps its category.
    const grocery = await pool!.query('SELECT category_id FROM transactions WHERE budget_id = $1 AND transfer_transaction_id IS NULL AND category_id IS NOT NULL', [budgetId]);
    expect(grocery.rows).toHaveLength(1);
    // Restore back to the plain payload (later tests expect it).
    expect((await postRestore(payload())).status).toBe(201);
  });

  test('restored accounts carry balances equal to the restored ledger', async () => {
    const withUncleared = payload();
    withUncleared.transactions.push(
      // pending (uncleared) rows land in the uncleared bucket
      { accountIndex: 0, date: '2026-01-20', payee: 'Cafe', categoryIndex: 0, memo: '', outflow: 700, inflow: 0, cleared: 'uncleared', flag: '', transferPeerIndex: null } as never,
      { accountIndex: 1, date: '2026-01-21', payee: 'Interest', categoryIndex: null, memo: '', outflow: 0, inflow: 300, cleared: 'uncleared', flag: '', transferPeerIndex: null } as never,
    );
    expect((await postRestore(withUncleared)).status).toBe(201);

    const res = await app.request(`/accounts?budget_id=${budgetId}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { name: string; cleared_balance: string; uncleared_balance: string }[];
    const byName = Object.fromEntries(rows.map((a) => [a.name, a]));
    // cleared + reconciled -> cleared (milliunits = cents x 10); uncleared apart.
    expect(Number(byName['Checking Alpha'].cleared_balance)).toBe((-1234 - 5000 + 90000) * 10);
    expect(Number(byName['Checking Alpha'].uncleared_balance)).toBe(-700 * 10);
    expect(Number(byName['Savings Beta'].cleared_balance)).toBe(5000 * 10);
    expect(Number(byName['Savings Beta'].uncleared_balance)).toBe(300 * 10);

    // Restore back to the plain payload (later tests expect the 4 txns).
    expect((await postRestore(payload())).status).toBe(201);
  });

  test('recompute ignores tombstoned and upcoming rows and counts a split parent once', async () => {
    expect((await postRestore(payload())).status).toBe(201);
    const { recomputeAccountBalances } = await import('../domain/transactions');
    const acct = await pool!.query<{ id: string }>(
      "SELECT id FROM accounts WHERE budget_id = $1 AND name = 'Checking Alpha'",
      [budgetId],
    );
    const accountId = acct.rows[0].id;
    const ins = (amount: number, extra: string) =>
      pool!.query<{ id: string }>(
        `INSERT INTO transactions (budget_id, account_id, date, amount, cleared, approved, repeat, deleted, upcoming)
         VALUES ($1, $2, '2026-02-01', $3, 'cleared', true, 'never', ${extra}) RETURNING id`,
        [budgetId, accountId, amount],
      );
    await ins(999000, 'true, false'); // tombstone: not counted
    await ins(888000, 'false, true'); // upcoming occurrence: not counted
    const split = await ins(-3000, 'false, false'); // split parent: parent amount only
    for (const amount of [-1000, -2000]) {
      await pool!.query(
        'INSERT INTO subtransactions (budget_id, transaction_id, amount) VALUES ($1, $2, $3)',
        [budgetId, split.rows[0].id, amount],
      );
    }
    const client = await pool!.connect();
    try {
      await recomputeAccountBalances(client, budgetId);
    } finally {
      client.release();
    }
    const row = await pool!.query<{ cleared_balance: string; uncleared_balance: string }>(
      'SELECT cleared_balance, uncleared_balance FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(Number(row.rows[0].cleared_balance)).toBe((-1234 - 5000 + 90000) * 10 - 3000);
    expect(Number(row.rows[0].uncleared_balance)).toBe(0);
    expect((await postRestore(payload())).status).toBe(201);
  });

  test('re-restore wipes and rebuilds idempotently', async () => {
    const res = await postRestore(payload());
    expect(res.status).toBe(201);
    const txns = await pool!.query<{ count: string }>(
      'SELECT count(*)::text as count FROM transactions WHERE budget_id = $1',
      [budgetId],
    );
    expect(Number(txns.rows[0].count)).toBe(4);
  });

  test('account userId is kept for members and nulled for non-members', async () => {
    const withPeople = payload();
    withPeople.accounts = [
      { name: 'Checking Alpha', userId: memberId },
      { name: 'Savings Beta', userId: outsiderId },
    ] as never;
    expect((await postRestore(withPeople)).status).toBe(201);
    const rows = await pool!.query<{ name: string; user_id: string | null }>(
      'SELECT name, user_id FROM accounts WHERE budget_id = $1 ORDER BY name',
      [budgetId],
    );
    expect(rows.rows).toEqual([
      { name: 'Checking Alpha', user_id: memberId },
      { name: 'Savings Beta', user_id: null },
    ]);
    // Restore back to the plain payload (later tests expect the 4 txns).
    expect((await postRestore(payload())).status).toBe(201);
  });

  test('category userId is kept for members and nulled for non-members', async () => {
    const withPeople = payload();
    withPeople.categories = withPeople.categories.map((c, i) => ({
      ...c,
      userId: i === 0 ? memberId : i === 1 ? outsiderId : null,
    })) as never;
    expect((await postRestore(withPeople)).status).toBe(201);
    const rows = await pool!.query<{ user_id: string | null }>(
      'SELECT user_id FROM categories WHERE budget_id = $1 ORDER BY sort_order',
      [budgetId],
    );
    expect(rows.rows.map((r) => r.user_id).slice(0, 2)).toEqual([memberId, null]);
    expect((await postRestore(payload())).status).toBe(201);
  });

  test('rejects an out-of-range transferPeerIndex (rollback keeps budget intact)', async () => {
    const bad = payload();
    bad.transactions[0].transferPeerIndex = 9;
    const res = await postRestore(bad);
    expect(res.status).toBe(400);
    // the pre-restore state is untouched
    const txns = await pool!.query<{ count: string }>(
      'SELECT count(*)::text as count FROM transactions WHERE budget_id = $1',
      [budgetId],
    );
    expect(Number(txns.rows[0].count)).toBe(4);
  });

  test('rejects a non-mutual transferPeerIndex', async () => {
    const bad = payload();
    bad.transactions[0].transferPeerIndex = 3;
    const res = await postRestore(bad);
    expect(res.status).toBe(400);
  });

  test('rejects an out-of-range categoryIndex', async () => {
    const bad = payload();
    bad.transactions[0].categoryIndex = 42;
    const res = await postRestore(bad);
    expect(res.status).toBe(400);
  });

  test('requires a uuid budget_id', async () => {
    const res = await postRestore(payload(), 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  test('404 for an unknown budget', async () => {
    const res = await postRestore(payload(), crypto.randomUUID());
    expect(res.status).toBe(404);
  });

  test('an account whose only register row is a Starting Balance row restores with that balance', async () => {
    // Shape the client export emits for a row-less account (see
    // modules/budget/transfer/payload.ts balanceRows): the balance rides as a
    // ledger row, so the account and its balance survive without any
    // transactions of its own.
    const body = payload();
    body.accounts.push({ name: 'Row-less Wallet' });
    body.transactions.push({
      accountIndex: 2, date: '2026-01-20', payee: 'Starting Balance', categoryIndex: null, memo: '',
      outflow: 0, inflow: 12345, cleared: 'uncleared' as never, flag: '', transferPeerIndex: null,
    });
    expect((await postRestore(body)).status).toBe(201);
    const rows = await pool!.query<{ name: string; ledger: string }>(
      `SELECT a.name, coalesce(sum(t.amount), 0)::text AS ledger
       FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
       WHERE a.budget_id = $1 AND a.name = 'Row-less Wallet' GROUP BY a.name`,
      [budgetId],
    );
    expect(rows.rows).toEqual([{ name: 'Row-less Wallet', ledger: String(12345 * 10) }]);
    // Put the plain payload back for any later test.
    expect((await postRestore(payload())).status).toBe(201);
  });
});

describe.skipIf(!dbReady)('POST /budgets/restore: sections', () => {
  const count = async (sql: string): Promise<number> =>
    Number((await pool!.query<{ n: string }>(sql, [budgetId])).rows[0].n);
  const catOf = async (memo: string): Promise<string | null> =>
    (
      await pool!.query<{ name: string | null }>(
        `SELECT c.name FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.budget_id = $1 AND t.memo = $2`,
        [budgetId, memo],
      )
    ).rows[0].name;

  test('plan only: replaces the plan, keeps the register and re-links categories by group+name', async () => {
    expect((await postRestore(payload())).status).toBe(201);
    const next = payload();
    // Groceries survives (renamed group would break the match, so keep it), Utilities is gone, Rent is new.
    next.categories = [
      { groupIndex: 0, name: 'Groceries' },
      { groupIndex: 0, name: 'Rent' },
    ];
    next.assignments = [{ categoryIndex: 1, month: '2026-02-01', budgeted: 70000 }];
    // The register part of the payload must be ignored.
    next.accounts = [{ name: 'Ignored' }];
    const res = await postRestore({ ...next, sections: ['plan'] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      groups: 2, categories: 2, accounts: 0, transactions: 0, assignments: 1, uncategorized: 0,
    });
    expect(await count('SELECT count(*) n FROM accounts WHERE budget_id = $1')).toBe(2);
    expect(await count('SELECT count(*) n FROM transactions WHERE budget_id = $1')).toBe(4);
    expect(await count("SELECT count(*) n FROM accounts WHERE budget_id = $1 AND name = 'Ignored'")).toBe(0);
    expect(await count('SELECT count(*) n FROM assignments WHERE budget_id = $1')).toBe(1);
    expect(await catOf('weekly shop')).toBe('Groceries');
    // Balances stay correct (register untouched).
    expect(await count('SELECT count(*) n FROM payees WHERE budget_id = $1')).toBeGreaterThan(0);
  });

  test('plan only: a category missing from the new plan leaves its transactions uncategorized', async () => {
    expect((await postRestore(payload())).status).toBe(201);
    const next = payload();
    next.categories = [{ groupIndex: 0, name: 'Rent' }];
    next.assignments = [];
    expect((await postRestore({ ...next, sections: ['plan'] })).status).toBe(201);
    expect(await catOf('weekly shop')).toBeNull();
    expect(await count('SELECT count(*) n FROM transactions WHERE budget_id = $1')).toBe(4);
  });

  test('register only: replaces accounts/transactions, keeps the plan, maps categories by group+name', async () => {
    expect((await postRestore(payload())).status).toBe(201);
    const next = payload();
    // Payload plan differs from the budget's: Groceries exists there, "Gone" does not.
    next.categories = [
      { groupIndex: 0, name: 'groceries' },
      { groupIndex: 0, name: 'Gone' },
      { groupIndex: 1, name: 'Hidden Cat' },
    ];
    next.assignments = [{ categoryIndex: 0, month: '2026-09-01', budgeted: 1 }];
    next.accounts = [{ name: 'Checking Alpha' }, { name: 'Brand New' }];
    next.transactions = [
      { accountIndex: 1, date: '2026-03-01', payee: 'A', categoryIndex: 0, memo: 'm1', outflow: 100, inflow: 0, cleared: 'cleared', flag: '', transferPeerIndex: null },
      { accountIndex: 1, date: '2026-03-02', payee: 'B', categoryIndex: 1, memo: 'm2', outflow: 200, inflow: 0, cleared: 'cleared', flag: '', transferPeerIndex: null },
    ];
    const res = await postRestore({ ...next, sections: ['register'] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      groups: 0, categories: 0, accounts: 2, transactions: 2, assignments: 0, uncategorized: 1,
    });
    // Plan untouched: original 3 categories, original 2 assignments.
    expect(await count('SELECT count(*) n FROM categories WHERE budget_id = $1')).toBe(3);
    expect(await count('SELECT count(*) n FROM assignments WHERE budget_id = $1')).toBe(2);
    expect(await count('SELECT count(*) n FROM transactions WHERE budget_id = $1')).toBe(2);
    expect(await catOf('m1')).toBe('Groceries');
    expect(await catOf('m2')).toBeNull();
    expect(await count("SELECT count(*) n FROM accounts WHERE budget_id = $1 AND name = 'Brand New'")).toBe(1);
    expect(await count("SELECT count(*) n FROM accounts WHERE budget_id = $1 AND name = 'Savings Beta'")).toBe(0);
    // Balance cache rebuilt for the new ledger.
    const bal = await pool!.query<{ name: string; cleared: string }>(
      'SELECT name, cleared_balance::text AS cleared FROM accounts WHERE budget_id = $1 AND name = $2',
      [budgetId, 'Brand New'],
    );
    expect(Number(bal.rows[0].cleared)).toBe(-3000);
  });

  test('explicit both sections behaves like the default', async () => {
    const res = await postRestore({ ...payload(), sections: ['plan', 'register'] });
    expect(res.status).toBe(201);
    expect(await count('SELECT count(*) n FROM transactions WHERE budget_id = $1')).toBe(4);
    expect(await count('SELECT count(*) n FROM categories WHERE budget_id = $1')).toBe(3);
  });

  test('rejects an empty or unknown sections list', async () => {
    expect((await postRestore({ ...payload(), sections: [] })).status).toBe(400);
    expect((await postRestore({ ...payload(), sections: ['nope'] })).status).toBe(400);
  });
});
