/**
 * Two OPEN accounts of one budget never share a name (case- and
 * space-insensitive): POST /accounts and PATCH /accounts/:id answer 409
 * `account_name_exists`. Closed and deleted accounts do not block, existing
 * duplicates stay editable, and restore / fresh start copy them untouched.
 *
 * In-process via app.request(); DB tests are skipped without Postgres.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';

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

// The budget barrel first: accounts.ts -> connections -> budget/index is an import cycle that
// only resolves when the barrel is the entry point (other route tests get this from run order).
await import('../index');
const restoreApp = (await import('./budget-restore')).default;
const budgetsApp = (await import('./budgets')).default;
const accountsApp = (await import('./accounts')).default;
const app = new (await import('hono')).Hono();
app.onError((await import('../../core/validate')).httpOnError);
const userId = crypto.randomUUID();
const user: IdentityUser = { id: userId, email: 'account-name-test@syscd.local', googleSub: null, role: 'user', status: 'active' };
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/restore', restoreApp);
app.route('/budgets', budgetsApp);
app.route('/accounts', accountsApp);

const budgets: string[] = [];
const newBudget = async (): Promise<string> => {
  const id = crypto.randomUUID();
  await pool!.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [id, 'account-name-test', userId]);
  budgets.push(id);
  return id;
};
const send = (method: string, path: string, body: object) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const create = (budget_id: string, name: string) => send('POST', '/accounts', { budget_id, name, type: 'checking' });
const patch = (budget_id: string, id: string, body: object) => send('PATCH', `/accounts/${id}`, { budget_id, ...body });
const seed = async (budgetId: string, name: string, flags: { closed?: boolean; deleted?: boolean } = {}): Promise<string> => {
  const id = crypto.randomUUID();
  await pool!.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group, closed, deleted)
     VALUES ($1, $2, $3, 'checking', $4::account_group, $5, $6)`,
    [id, budgetId, name, flags.closed ? 'CLOSED' : 'CASH', flags.closed ?? false, flags.deleted ?? false],
  );
  return id;
};
const countNamed = async (budgetId: string, name: string) =>
  (await pool!.query('SELECT 1 FROM accounts WHERE budget_id = $1 AND name = $2', [budgetId, name])).rowCount;
type Err = { error: string; code: string; params?: { name: string } };

beforeAll(async () => {
  if (!dbReady || !pool) return;
  await (await import('../../core/migrate')).runMigrations();
  await pool.query("INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')", [userId, user.email]);
});
afterAll(async () => {
  if (!dbReady || !pool) return;
  await pool.query('DELETE FROM budgets WHERE id = ANY($1)', [budgets]);
  await pool.query('DELETE FROM budgets WHERE owner_user_id = $1', [userId]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
});

describe('POST /accounts: duplicate open name', () => {
  test.skipIf(!dbReady)('refused with 409 account_name_exists, case- and space-insensitively, and writes nothing', async () => {
    const b = await newBudget();
    expect((await create(b, 'Nubank Conta')).status).toBe(201);
    for (const dup of ['Nubank Conta', 'nubank conta', '  NUBANK   conta ']) {
      const res = await create(b, dup);
      expect(res.status).toBe(409);
      const body = (await res.json()) as Err;
      expect(body.code).toBe('account_name_exists');
      expect(body.params).toEqual({ name: 'Nubank Conta' });
    }
    const n = await pool!.query('SELECT 1 FROM accounts WHERE budget_id = $1', [b]);
    expect(n.rowCount).toBe(1);
    const payees = await pool!.query("SELECT 1 FROM payees WHERE budget_id = $1 AND transfer_account_id IS NOT NULL", [b]);
    expect(payees.rowCount).toBe(1);
  });

  test.skipIf(!dbReady)('the same name in another budget is fine', async () => {
    const [a, b] = [await newBudget(), await newBudget()];
    expect((await create(a, 'Shared Name')).status).toBe(201);
    expect((await create(b, 'Shared Name')).status).toBe(201);
  });

  test.skipIf(!dbReady)('a closed or deleted account does not block the name', async () => {
    const b = await newBudget();
    await seed(b, 'Old Savings', { closed: true });
    await seed(b, 'Gone Card', { deleted: true });
    expect((await create(b, 'old savings')).status).toBe(201);
    expect((await create(b, 'Gone Card')).status).toBe(201);
  });

  test.skipIf(!dbReady)('concurrent creates of one name: exactly one wins', async () => {
    const b = await newBudget();
    const results = await Promise.all(Array.from({ length: 8 }, () => create(b, 'Race Account')));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    expect(await countNamed(b, 'Race Account')).toBe(1);
  });

  test.skipIf(!dbReady)('a create waits for an open transaction that holds the name, then is refused', async () => {
    const b = await newBudget();
    const store = await import('../store/accounts');
    const holder = await pool!.connect();
    try {
      // Another request, mid-transaction: took the budget lock, saw the name free, inserted, not committed yet.
      await holder.query('BEGIN');
      expect(await store.lockBudgetForAccountNames(holder, b)).toBe(true);
      expect(await store.findOpenAccountNamed(holder, b, 'Held', null)).toBeUndefined();
      await store.insertAccount(holder, { budgetId: b, name: 'Held', type: 'checking', accountGroup: 'CASH', onBudget: true, userId: null, currency: null });

      let settled = false;
      const waiting = Promise.resolve(create(b, 'held')).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // blocked on the lock, not racing past the check
      await holder.query('COMMIT');
      const res = await waiting;
      expect(res.status).toBe(409);
      expect(((await res.json()) as Err).code).toBe('account_name_exists');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await pool!.query('SELECT 1 FROM accounts WHERE budget_id = $1', [b]).then((r) => r.rowCount)).toBe(1);
  });

  test.skipIf(!dbReady)('concurrent create and rename to one name: exactly one wins', async () => {
    const b = await newBudget();
    const other = (await (await create(b, 'Other')).json()) as { id: string };
    const [r1, r2] = await Promise.all([create(b, 'Contested'), patch(b, other.id, { name: 'contested' })]);
    expect([r1.status === 201, r2.status === 200].filter(Boolean)).toHaveLength(1);
    const open = await pool!.query("SELECT 1 FROM accounts WHERE budget_id = $1 AND lower(name) = 'contested'", [b]);
    expect(open.rowCount).toBe(1);
  });
});

describe('PATCH /accounts/:id: rename and reopen', () => {
  test.skipIf(!dbReady)('rename onto another open account is refused and keeps the old name', async () => {
    const b = await newBudget();
    await create(b, 'Alpha');
    const beta = (await (await create(b, 'Beta')).json()) as { id: string };
    const res = await patch(b, beta.id, { name: ' alpha ' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Err).code).toBe('account_name_exists');
    expect((await pool!.query('SELECT name FROM accounts WHERE id = $1', [beta.id])).rows[0].name).toBe('Beta');
    // The transfer payee did not move either.
    expect((await pool!.query('SELECT p.name FROM payees p JOIN accounts a ON a.transfer_payee_id = p.id WHERE a.id = $1', [beta.id])).rows[0].name).toBe('Transfer : Beta');
  });

  test.skipIf(!dbReady)('rename onto a closed account, or to its own name in other case, is allowed', async () => {
    const b = await newBudget();
    await seed(b, 'Closed One', { closed: true });
    const acc = (await (await create(b, 'Plain')).json()) as { id: string };
    expect((await patch(b, acc.id, { name: 'Closed One' })).status).toBe(200);
    expect((await patch(b, acc.id, { name: 'CLOSED ONE' })).status).toBe(200);
  });

  test.skipIf(!dbReady)('an existing duplicate stays editable: other fields, the same name, closing', async () => {
    const b = await newBudget();
    const first = await seed(b, 'Twin');
    const second = await seed(b, 'twin');
    expect((await patch(b, second, { note: 'still here' })).status).toBe(200);
    expect((await patch(b, second, { name: 'twin', note: 'resent' })).status).toBe(200);
    expect((await patch(b, first, { user_id: null, currency: 'USD' })).status).toBe(200);
    const closed = await patch(b, second, { closed: true });
    expect(closed.status).toBe(200);
    // Closing the duplicate freed the name: the other one can be renamed to it, and reopening is now refused.
    expect((await patch(b, first, { name: 'Twin Renamed' })).status).toBe(200);
  });

  test.skipIf(!dbReady)('reopening INTO a duplicate is refused, reopening a free name works', async () => {
    const b = await newBudget();
    const closed = await seed(b, 'Cycle', { closed: true });
    await seed(b, 'cycle');
    const blocked = await patch(b, closed, { closed: false });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as Err).code).toBe('account_name_exists');
    expect((await pool!.query('SELECT closed FROM accounts WHERE id = $1', [closed])).rows[0].closed).toBe(true);
    // Reopen together with a new name works.
    expect((await patch(b, closed, { closed: false, name: 'Cycle Two' })).status).toBe(200);
    // A closed account with no open namesake reopens as before.
    const free = await seed(b, 'Free Name', { closed: true });
    expect((await patch(b, free, { closed: false })).status).toBe(200);
  });
});

describe('existing duplicates survive restore and fresh start', () => {
  test.skipIf(!dbReady)('restore of a payload with two same-named accounts keeps both', async () => {
    const b = await newBudget();
    const res = await send('POST', `/restore?budget_id=${b}`, {
      groups: [],
      categories: [],
      accounts: [{ name: 'Dup' }, { name: 'dup' }],
      transactions: [],
      assignments: [],
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { accounts: number }).accounts).toBe(2);
  });

  test.skipIf(!dbReady)('fresh start copies existing duplicates', async () => {
    const b = await newBudget();
    await seed(b, 'Dup');
    await seed(b, 'Dup');
    const res = await send('POST', '/budgets/fresh-start', { budget_id: b });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: { id: string } };
    budgets.push(body.created.id);
    expect(await countNamed(body.created.id, 'Dup')).toBe(2);
  });
});
