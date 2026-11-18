/**
 * Regression for budget-njc: a "Transfer : <name>" payee must only ever link to
 * an account of ITS OWN budget, even when another budget has an account with
 * the same name. Covers every path that resolves a transfer payee by name:
 * restore, account create, first-use link on a transfer, and fresh-start.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Pool } from 'pg';

import { httpOnError } from '../../core/validate';
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

const userId = crypto.randomUUID();
const user: IdentityUser = { id: userId, email: 'transfer-scope@syscd.local', googleSub: null, role: 'user', status: 'active' };
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/restore', (await import('./budget-restore')).default);
app.route('/budgets', (await import('./budgets')).default);
app.route('/accounts', (await import('./accounts')).default);
app.route('/transactions', (await import('./transactions')).default);

const budgetA = crypto.randomUUID();
const budgetB = crypto.randomUUID();
const bAccount = crypto.randomUUID();
const extraBudgets: string[] = [];
const SHARED = 'Shared Acc';

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Budget B owns an account named SHARED and its (correctly linked) transfer payee. */
async function seedB() {
  await pool!.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget) VALUES ($1, $2, $3, 'checking', 'CASH', true)`,
    [bAccount, budgetB, SHARED],
  );
  await pool!.query(`INSERT INTO payees (budget_id, name, transfer_account_id) VALUES ($1, $2, $3)`, [
    budgetB,
    `Transfer : ${SHARED}`,
    bAccount,
  ]);
}

const transferTxn = (accountId: string, payee: string) => ({
  account_id: accountId,
  date: '2025-07-01',
  payee,
  category_id: null,
  memo: '',
  outflow: 1000,
  inflow: 0,
  cleared: 'uncleared',
  approved: true,
  flag: null,
  repeat: 'never',
});

async function linkedAccount(budgetId: string, payeeName: string) {
  const r = await pool!.query<{ transfer_account_id: string | null; account_budget: string | null }>(
    `SELECT p.transfer_account_id, a.budget_id AS account_budget
       FROM payees p LEFT JOIN accounts a ON a.id = p.transfer_account_id
      WHERE p.budget_id = $1 AND p.name = $2`,
    [budgetId, payeeName],
  );
  return r.rows[0];
}

beforeAll(async () => {
  if (!dbReady) return;
  await (await import('../../core/migrate')).runMigrations();
  await pool!.query(`INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')`, [
    userId,
    user.email,
  ]);
  for (const id of [budgetA, budgetB]) {
    await pool!.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [id, 'scope-test', userId]);
  }
  await seedB();
});

afterAll(async () => {
  if (!dbReady) return;
  await pool!.query('DELETE FROM budgets WHERE id = ANY($1)', [[budgetA, budgetB, ...extraBudgets]]);
  await pool!.query('DELETE FROM public.users WHERE id = $1', [userId]);
});

describe.skipIf(!dbReady)('transfer payee never links across budgets', () => {
  test('restore links Transfer payees to the restored budget own account, and a transfer to it succeeds', async () => {
    const res = await send('POST', `/restore?budget_id=${budgetA}`, {
      groups: [],
      categories: [],
      accounts: [{ name: SHARED }, { name: 'Other Acc' }],
      transactions: [0, 1].map((i) => ({
        accountIndex: i,
        date: '2026-01-06',
        payee: '',
        categoryIndex: null,
        memo: '',
        outflow: i === 0 ? 5000 : 0,
        inflow: i === 0 ? 0 : 5000,
        cleared: 'cleared',
        flag: '',
        transferPeerIndex: 1 - i,
      })),
      assignments: [],
    });
    expect(res.status).toBe(201);
    const accs = await pool!.query<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE budget_id = $1', [budgetA]);
    const shared = accs.rows.find((a) => a.name === SHARED)!;
    const other = accs.rows.find((a) => a.name === 'Other Acc')!;

    const link = await linkedAccount(budgetA, `Transfer : ${SHARED}`);
    expect(link.transfer_account_id).toBe(shared.id);
    expect(link.account_budget).toBe(budgetA);
    // B untouched
    expect((await linkedAccount(budgetB, `Transfer : ${SHARED}`)).transfer_account_id).toBe(bAccount);

    const t = await send('POST', '/transactions', { budget_id: budgetA, txn: transferTxn(other.id, `Transfer : ${SHARED}`) });
    expect(t.status).toBe(201);
    const row = (await t.json()) as { transfer_account_id: string };
    expect(row.transfer_account_id).toBe(shared.id);
  });

  test('account create links the new Transfer payee to the new account of its own budget', async () => {
    const res = await send('POST', '/accounts', {
      budget_id: budgetA,
      name: 'Created Twin',
      type: 'checking',
      on_budget: true,
      balance: 0,
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    const link = await linkedAccount(budgetA, 'Transfer : Created Twin');
    expect(link.transfer_account_id).toBe(id);
    expect(link.account_budget).toBe(budgetA);
  });

  test('an unlinked "Transfer : <name>" payee links to its own budget account on first use', async () => {
    const twinB = crypto.randomUUID();
    const twinA = crypto.randomUUID();
    const src = crypto.randomUUID();
    for (const [id, b, n] of [
      [twinB, budgetB, 'Legacy Twin'],
      [twinA, budgetA, 'Legacy Twin'],
      [src, budgetA, 'Legacy Src'],
    ] as const) {
      await pool!.query(
        `INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget) VALUES ($1, $2, $3, 'checking', 'CASH', true)`,
        [id, b, n],
      );
    }
    await pool!.query(`INSERT INTO payees (budget_id, name) VALUES ($1, 'Transfer : Legacy Twin')`, [budgetA]);
    const t = await send('POST', '/transactions', { budget_id: budgetA, txn: transferTxn(src, 'Transfer : Legacy Twin') });
    expect(t.status).toBe(201);
    expect((await linkedAccount(budgetA, 'Transfer : Legacy Twin')).transfer_account_id).toBe(twinA);
  });

  test('fresh-start keeps the new budget transfer payees on the new budget accounts', async () => {
    const created = (await (await send('POST', '/budgets', { name: 'Scope Fresh' })).json()) as { id: string };
    extraBudgets.push(created.id);
    const acc = await send('POST', '/accounts', {
      budget_id: created.id,
      name: SHARED,
      type: 'checking',
      on_budget: true,
      balance: 0,
    });
    expect(acc.status, await acc.clone().text()).toBe(201);
    const res = await send('POST', '/budgets/fresh-start', { budget_id: created.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: { id: string } };
    extraBudgets.push(body.created.id);
    const link = await linkedAccount(body.created.id, `Transfer : ${SHARED}`);
    expect(link.account_budget).toBe(body.created.id);
  });
});
