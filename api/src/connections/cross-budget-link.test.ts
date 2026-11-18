/**
 * A connection belongs to a user, not to a budget: the accounts it feeds can
 * live in several of that user's budgets. The bank page lists them all from
 * GET /connections/:id/summary and edits each link through PATCH /accounts/:id,
 * which finds the account only inside the budget named in the body.
 *
 * Regression (production, 2026-11-18): the page sent the active budget's id
 * for an account living in another budget, so Unlink answered 404 "account
 * not found" and the bank could not be removed. The summary must hand out the
 * budget each account lives in, and that id must be the one that unlinks it.
 * DB-gated.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { accountsRouter } from '../budget';
import { pool } from '../core/db';
import { httpOnError } from '../core/validate';
import type { IdentityUser } from '../user';
import connectionsApp from './routes';
import { upsertConnection } from './store';

let dbReady = false;
try {
  await pool.query('SELECT 1');
  dbReady = (await pool.query("select to_regclass('public.connection_transactions')::text as t")).rows[0]?.t != null;
} catch {
  dbReady = false;
}

const user: IdentityUser = {
  id: crypto.randomUUID(),
  email: 'connections-cross-budget@syscd.local',
  googleSub: null,
  role: 'user',
  status: 'active',
};

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/connections', connectionsApp);
app.route('/accounts', accountsRouter);

const unlink = (accountId: string, budgetId: string) =>
  app.request(`/accounts/${accountId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ budget_id: budgetId, link: { connectionId: null } }),
  });

describe.skipIf(!dbReady)('one connection feeding accounts in two budgets', () => {
  const activeBudget = crypto.randomUUID();
  const otherBudget = crypto.randomUUID();
  const inActive = crypto.randomUUID();
  const inOther = crypto.randomUUID();
  let connectionId = '';

  beforeAll(async () => {
    await pool.query(`INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')`, [user.id, user.email]);
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $3, $4), ($2, $5, $4)', [
      activeBudget,
      otherBudget,
      'cross-budget-active',
      user.id,
      'cross-budget-other',
    ]);
    connectionId = (await upsertConnection({ userId: user.id, provider: 'xb-test', externalId: `xb-${crypto.randomUUID()}`, status: 'connected' })).id;
    await pool.query(
      `INSERT INTO accounts (id, budget_id, name, type, account_group, connection_id, external_account_id)
       VALUES ($1, $3, 'In Active', 'checking', 'CASH', $5, 'ext-a'),
              ($2, $4, 'In Other', 'checking', 'CASH', $5, 'ext-b')`,
      [inActive, inOther, activeBudget, otherBudget, connectionId],
    );
  });
  afterAll(async () => {
    await pool.query('DELETE FROM public.budgets WHERE id = ANY($1)', [[activeBudget, otherBudget]]);
    await pool.query('DELETE FROM public.connections WHERE id = $1', [connectionId]);
    await pool.query('DELETE FROM public.users WHERE id = $1', [user.id]);
  });

  test('summary lists both accounts, each with the budget it lives in', async () => {
    const res = await app.request(`/connections/${connectionId}/summary`);
    expect(res.status).toBe(200);
    const { accounts } = (await res.json()) as { accounts: { accountId: string; budgetId: string }[] };
    expect(accounts.map((a) => [a.accountId, a.budgetId]).sort()).toEqual(
      [
        [inActive, activeBudget],
        [inOther, otherBudget],
      ].sort(),
    );
  });

  test('the wrong budget is the production failure: 404 account not found, link untouched', async () => {
    const res = await unlink(inOther, activeBudget);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('account not found');
    const row = await pool.query('SELECT connection_id FROM accounts WHERE id = $1', [inOther]);
    expect(row.rows[0].connection_id).toBe(connectionId);
  });

  test('every account in the summary unlinks with the budgetId the summary gave, then the bank can be removed', async () => {
    const { accounts } = (await (await app.request(`/connections/${connectionId}/summary`)).json()) as {
      accounts: { accountId: string; budgetId: string }[];
    };
    expect(accounts).toHaveLength(2);
    for (const a of accounts) {
      const res = await unlink(a.accountId, a.budgetId);
      expect(res.status).toBe(200);
      expect((await res.json()).connection_id).toBeNull();
    }
    const after = (await (await app.request(`/connections/${connectionId}/summary`)).json()) as { accounts: unknown[] };
    expect(after.accounts).toEqual([]);
  });
});
