/**
 * Characterisation tests for the repeat-rules routes and the generation
 * engine (written before moving their SQL into budget/store and
 * budget/domain; they pin the behaviour as it was): template create
 * materializes upcoming rows within the horizon without moving balances,
 * generate is idempotent, Make Repeating on a future-dated anchor marks it
 * upcoming and withholds its delta, a passed-due upcoming row flips to
 * entered and applies its delta, delete retires the rule and its pending
 * rows, foreign budgets 404.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { pool } from '../../core/db';
import { dbReady } from '../../core/test-gate';
import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';
import { generateAllBudgets } from '../domain/repeat-generation';
import repeatRulesApp from './repeat-rules';

const owner: IdentityUser = {
  id: crypto.randomUUID(),
  email: 'rr-owner@repeatrules.test',
  googleSub: null,
  role: 'user',
  status: 'active',
};
const budgetId = crypto.randomUUID();
const otherBudgetId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const otherAccountId = crypto.randomUUID();
const json = { 'content-type': 'application/json' };

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', owner);
  return next();
});
app.route('/repeat-rules', repeatRulesApp);

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const balances = async () =>
  (
    await pool.query<{ cleared_balance: number; uncleared_balance: number }>(
      'SELECT cleared_balance, uncleared_balance FROM accounts WHERE id = $1',
      [accountId],
    )
  ).rows[0]!;

const ruleRows = async (ruleId: string) =>
  (
    await pool.query<{ date: string; amount: number; upcoming: boolean; deleted: boolean; cleared: string; approved: boolean }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, amount, upcoming, deleted, cleared, approved
         FROM transactions WHERE repeat_rule_id = $1 ORDER BY date`,
      [ruleId],
    )
  ).rows;

async function cleanup() {
  await pool.query('DELETE FROM budgets WHERE id = ANY($1)', [[budgetId, otherBudgetId]]);
  await pool.query(`DELETE FROM public.users WHERE email LIKE 'rr-%@repeatrules.test'`);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, 'user')`, [owner.id, owner.email]);
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'rr-test', $2)`, [budgetId, owner.id]);
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'rr-other', NULL)`, [otherBudgetId]);
  await pool.query(`INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2)`, [budgetId, owner.id]);
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget) VALUES
       ($1, $2, 'Checking', 'checking', 'CASH', true), ($3, $4, 'Theirs', 'checking', 'CASH', true)`,
    [accountId, budgetId, otherAccountId, otherBudgetId],
  );
});

afterAll(async () => {
  if (dbReady) await cleanup();
});

describe.skipIf(!dbReady)('repeat rules (characterisation)', () => {
  let templateRuleId = '';

  test('template create (monthly, due tomorrow) materializes upcoming rows; balances untouched', async () => {
    const res = await send('POST', '/repeat-rules', {
      budget_id: budgetId,
      account_id: accountId,
      payee: 'Rent Co',
      category_id: null,
      memo: 'rent',
      outflow_cents: 12_345,
      inflow_cents: 0,
      frequency: 'monthly',
      next_due_date: isoDay(1),
    });
    expect(res.status).toBe(201);
    const rule = (await res.json()) as { id: string; amount: number; next_due_date: string; budget_id: string };
    templateRuleId = rule.id;
    expect(rule.budget_id).toBe(budgetId);
    expect(Number(rule.amount)).toBe(-123_450);
    const rows = await ruleRows(rule.id);
    // Due tomorrow, monthly, 3-month horizon: 3 or 4 occurrences (calendar dependent).
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.length).toBeLessThanOrEqual(4);
    expect(rows[0]!.date).toBe(isoDay(1));
    for (const r of rows) {
      expect(r).toMatchObject({ amount: -123_450, upcoming: true, deleted: false, cleared: 'uncleared', approved: true });
    }
    expect(await balances()).toEqual({ cleared_balance: 0, uncleared_balance: 0 });
    // The payee was created through the rename-rule path.
    const payee = await pool.query('SELECT 1 FROM payees WHERE budget_id = $1 AND name = $2', [budgetId, 'Rent Co']);
    expect(payee.rowCount).toBe(1);
  });

  test('generate is idempotent (nothing flipped, nothing created)', async () => {
    const res = await send('POST', '/repeat-rules/generate', { budget_id: budgetId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flipped: 0, created: 0 });
  });

  test('list returns live rules of the budget', async () => {
    const res = await app.request(`/repeat-rules?budget_id=${budgetId}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([templateRuleId]);
  });

  test('a passed-due upcoming row flips to entered and applies its withheld delta (generateAllBudgets)', async () => {
    // Backdate the first occurrence: it is due now.
    await pool.query(
      `UPDATE transactions SET date = $2, occurrence_date = $2
        WHERE id = (SELECT id FROM transactions WHERE repeat_rule_id = $1 ORDER BY date LIMIT 1)`,
      [templateRuleId, isoDay(-1)],
    );
    await generateAllBudgets();
    const rows = await ruleRows(templateRuleId);
    expect(rows[0]).toMatchObject({ date: isoDay(-1), upcoming: false, deleted: false });
    expect(await balances()).toEqual({ cleared_balance: 0, uncleared_balance: -123_450 });
  });

  test('Make Repeating a future-dated anchor marks it upcoming and reverses its entry delta', async () => {
    const anchorId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO transactions (id, budget_id, account_id, date, amount, cleared, approved, repeat, deleted)
       VALUES ($1, $2, $3, $4, -50000, 'uncleared', true, 'never', false)`,
      [anchorId, budgetId, accountId, isoDay(5)],
    );
    // As if the create route had applied the entry delta.
    await pool.query('UPDATE accounts SET uncleared_balance = uncleared_balance - 50000 WHERE id = $1', [accountId]);
    const res = await send('POST', '/repeat-rules', {
      budget_id: budgetId,
      account_id: accountId,
      payee: 'ignored',
      category_id: null,
      memo: null,
      outflow_cents: 1,
      inflow_cents: 0,
      frequency: 'weekly',
      attach_transaction_id: anchorId,
    });
    expect(res.status).toBe(201);
    const rule = (await res.json()) as { id: string; amount: number; next_due_date: string };
    expect(Number(rule.amount)).toBe(-50_000);
    const anchor = await pool.query<{ repeat_rule_id: string; upcoming: boolean; repeat: string }>(
      'SELECT repeat_rule_id, upcoming, repeat FROM transactions WHERE id = $1',
      [anchorId],
    );
    expect(anchor.rows[0]).toEqual({ repeat_rule_id: rule.id, upcoming: true, repeat: 'weekly' });
    // Entry delta reversed: back to the flipped template row only.
    expect(await balances()).toEqual({ cleared_balance: 0, uncleared_balance: -123_450 });
    // Weekly occurrences after the anchor were materialized too.
    expect((await ruleRows(rule.id)).length).toBeGreaterThan(1);

    // Attaching the same anchor again is a 409.
    const again = await send('POST', '/repeat-rules', {
      budget_id: budgetId,
      account_id: accountId,
      payee: 'ignored',
      category_id: null,
      memo: null,
      outflow_cents: 1,
      inflow_cents: 0,
      frequency: 'weekly',
      attach_transaction_id: anchorId,
    });
    expect(again.status).toBe(409);
  });

  test('validation: foreign account 400, missing next_due_date 400, both amounts 400', async () => {
    const base = {
      budget_id: budgetId,
      account_id: accountId,
      payee: 'X',
      category_id: null,
      memo: null,
      outflow_cents: 100,
      inflow_cents: 0,
      frequency: 'monthly',
    };
    expect((await send('POST', '/repeat-rules', { ...base, account_id: otherAccountId, next_due_date: isoDay(1) })).status).toBe(400);
    expect((await send('POST', '/repeat-rules', base)).status).toBe(400);
    expect((await send('POST', '/repeat-rules', { ...base, inflow_cents: 5, next_due_date: isoDay(1) })).status).toBe(400);
  });

  test('delete retires the rule and its pending rows, detaches entered rows; repeat is 404', async () => {
    const res = await send('DELETE', `/repeat-rules/${templateRuleId}?budget_id=${budgetId}`);
    expect(res.status).toBe(204);
    const live = await pool.query<{ upcoming: boolean; deleted: boolean; repeat_rule_id: string | null }>(
      `SELECT upcoming, deleted, repeat_rule_id FROM transactions
        WHERE budget_id = $1 AND account_id = $2 AND amount = -123450 ORDER BY date`,
      [budgetId, accountId],
    );
    // The flipped (entered) row survives, detached; pending ones are deleted.
    expect(live.rows[0]).toEqual({ upcoming: false, deleted: false, repeat_rule_id: null });
    expect(live.rows.slice(1).every((r) => r.deleted && r.repeat_rule_id === null)).toBe(true);
    const rule = await pool.query<{ deleted: boolean }>('SELECT deleted FROM txn_repeat_rules WHERE id = $1', [templateRuleId]);
    expect(rule.rows[0]!.deleted).toBe(true);
    expect((await send('DELETE', `/repeat-rules/${templateRuleId}?budget_id=${budgetId}`)).status).toBe(404);
  });

  test('foreign budget is 404 (budgetAccess)', async () => {
    const res = await send('POST', '/repeat-rules/generate', { budget_id: otherBudgetId });
    expect(res.status).toBe(404);
  });
});
