/**
 * Money units on the wire (phase 5d, G7): every amount, in both directions,
 * is integer MILLIUNITS. Property-style round trips: a pseudo-random amount is
 * written through an operation and must read back EXACTLY equal through the
 * matching read operation (no x10 / /10 anywhere in between).
 *
 * Sub-cent values (not multiples of 10) are accepted and preserved, because
 * the database already holds YNAB-imported milliunits; the only exception is
 * category targets, whose table stores whole cents.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts } from '@shared/contracts/budget';
import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { makeOpCaller } from '../core/test-op';
import { httpOnError } from '../core/validate';
import type { IdentityUser } from '../user';
import budget from '.';

const user: IdentityUser = {
  id: crypto.randomUUID(),
  email: 'money-units@moneyunits.test',
  googleSub: null,
  role: 'user',
  status: 'active',
};
const B = crypto.randomUUID();
const R = crypto.randomUUID(); // restore target
const group = crypto.randomUUID();
const cat1 = crypto.randomUUID();
const cat2 = crypto.randomUUID();

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);

/** Deterministic PRNG (mulberry32) so a failure reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(5_042_026);
/** 1 .. 10,000,000 milliunits (0.001 .. 10,000.000); every 3rd value is sub-cent. */
const amount = (i: number) => {
  const v = 1 + Math.floor(rand() * 10_000_000);
  return i % 3 === 0 ? v : v - (v % 10) + 10;
};
const N = 12;

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE id = ANY($1)', [[B, R]]);
  await pool.query(`DELETE FROM public.users WHERE email LIKE '%@moneyunits.test'`);
}

let account = '';

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, 'user')`, [user.id, user.email]);
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'money-units', $2), ($3, 'money-units-restore', $2)`, [
    B, user.id, R,
  ]);
  await pool.query(`INSERT INTO budget_members (budget_id, user_id) VALUES ($1, $2), ($3, $2)`, [B, user.id, R]);
  await pool.query(`INSERT INTO category_groups (id, budget_id, name, sort_order) VALUES ($1, $2, 'G', 0)`, [group, B]);
  await pool.query(
    `INSERT INTO categories (id, budget_id, group_id, name, sort_order) VALUES ($1, $3, $4, 'C1', 0), ($2, $3, $4, 'C2', 1)`,
    [cat1, cat2, B, group],
  );
});
afterAll(async () => {
  if (dbReady) await cleanup();
});

const txnBase = (over: Record<string, unknown>) => ({
  account_id: account,
  date: '2026-03-10',
  payee: 'Money Units Shop',
  category_id: null,
  memo: null,
  outflow: 0,
  inflow: 0,
  cleared: 'uncleared',
  approved: true,
  flag: null,
  repeat: 'never',
  ...over,
});

async function liveTxn(id: string) {
  const list = await op('budget_transactions_list', { budget_id: B });
  expect(list.status).toBe(200);
  return (list.json as { id: string; amount: number; subtransactions: { amount: number }[] }[]).find((t) => t.id === id)!;
}

async function accountRow(id: string) {
  const list = await op('budget_accounts_list', { budget_id: B });
  return (list.json as { id: string; cleared_balance: number; uncleared_balance: number }[]).find((a) => a.id === id)!;
}

describe.skipIf(!dbReady)('money units: write milliunits, read the same milliunits', () => {
  test('account opening balance (incl. a sub-cent value) reads back as the working balance', async () => {
    const created = await op('budget_accounts_create', { budget_id: B, name: 'MU Checking', type: 'checking', balance: 1_234_567 });
    expect(created.status).toBe(201);
    account = created.json.id;
    const row = await accountRow(account);
    expect(row.cleared_balance + row.uncleared_balance).toBe(1_234_567);
  });

  test('transactions create (outflow / inflow) and update round-trip for N random amounts', async () => {
    for (let i = 0; i < N; i++) {
      const out = amount(i);
      const created = await op('budget_transactions_create', { budget_id: B, txn: txnBase({ outflow: out }) });
      expect(created.status).toBe(201);
      expect(created.json.amount).toBe(-out);
      expect((await liveTxn(created.json.id)).amount).toBe(-out);

      const inflow = amount(i + 1);
      const upd = await op('budget_transactions_update', { id: created.json.id, budget_id: B, patch: { outflow: 0, inflow } });
      expect(upd.status).toBe(204);
      expect((await liveTxn(created.json.id)).amount).toBe(inflow);
    }
  });

  test('split legs keep their milliunits; the parent is their exact sum', async () => {
    const a = amount(0);
    const b = amount(1);
    const created = await op('budget_transactions_create', {
      budget_id: B,
      txn: txnBase({ outflow: a + b }),
      subtransactions: [
        { category_id: cat1, memo: 'a', outflow: a, inflow: 0 },
        { category_id: cat2, memo: 'b', outflow: b, inflow: 0 },
      ],
    });
    expect(created.status).toBe(201);
    const row = await liveTxn(created.json.id);
    expect(row.amount).toBe(-(a + b));
    expect(row.subtransactions.map((s) => s.amount).sort((x, y) => x - y)).toEqual([-a, -b].sort((x, y) => x - y));
  });

  test('transaction_add takes one signed amount', async () => {
    for (const signed of [-amount(0), amount(1), -12_345]) {
      const res = await op('budget_transaction_add', { budget_id: B, account_id: account, amount: signed, payee: 'MU Add' });
      expect(res.status).toBe(201);
      expect((await liveTxn(res.json.id)).amount).toBe(signed);
    }
  });

  test('bulk import rows store their milliunits as sent', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      date: '2026-03-11',
      payee: `MU Bulk ${i}`,
      category_id: null,
      memo: '',
      outflow: i % 2 ? amount(i) : 0,
      inflow: i % 2 ? 0 : amount(i),
      import_id: `mu-bulk-${i}`,
    }));
    const res = await op('budget_transactions_bulk_import', { budget_id: B, account_id: account, txns: rows });
    expect(res.status).toBe(201);
    const list = (await op('budget_transactions_list', { budget_id: B })).json as { import_id: string | null; amount: number }[];
    for (const r of rows) {
      expect(list.find((t) => t.import_id === r.import_id)?.amount).toBe(r.inflow - r.outflow);
    }
  });

  test('working balance override and reconcile set the exact milliunit balance', async () => {
    const working = amount(4);
    expect((await op('budget_accounts_update', { id: account, budget_id: B, working_balance: working })).status).toBe(200);
    let row = await accountRow(account);
    expect(row.cleared_balance + row.uncleared_balance).toBe(working);

    const stated = amount(5);
    expect((await op('budget_accounts_reconcile', { id: account, budget_id: B, stated_balance: stated })).status).toBe(204);
    row = await accountRow(account);
    expect(row.cleared_balance + row.uncleared_balance).toBe(stated);
  });

  test('assignments (set, batch, auto-assign) read back unchanged', async () => {
    const month = '2026-03-01';
    const read = async (categoryId: string) =>
      ((await op('budget_assignments_list', { budget_id: B })).json as { category_id: string; month: string; budgeted: number }[]).find(
        (a) => a.category_id === categoryId && String(a.month).startsWith('2026-03'),
      )?.budgeted;
    for (let i = 0; i < N; i++) {
      const v = (i % 2 ? -1 : 1) * amount(i);
      expect((await op('budget_assignments_set', { budget_id: B, month, category_id: cat1, budgeted: v })).status).toBeLessThan(300);
      expect(await read(cat1)).toBe(v);
    }
    const b1 = amount(7);
    const b2 = amount(8);
    const batch = await op('budget_assignments_batch', {
      budget_id: B,
      month,
      updates: [
        { category_id: cat1, budgeted: b1 },
        { category_id: cat2, budgeted: b2 },
      ],
    });
    expect(batch.status).toBeLessThan(300);
    expect(await read(cat1)).toBe(b1);
    expect(await read(cat2)).toBe(b2);
    const assigned = amount(9);
    expect((await op('budget_plan_auto_assign', { budget_id: B, month, rows: [{ category_id: cat2, assigned }] })).status).toBeLessThan(300);
    expect(await read(cat2)).toBe(assigned);
  });

  test('repeat rule amount reads back as the signed milliunits sent', async () => {
    const out = amount(3);
    const res = await op('budget_repeat_rules_create', {
      budget_id: B,
      account_id: account,
      payee: 'MU Rent',
      category_id: null,
      memo: null,
      outflow: out,
      inflow: 0,
      frequency: 'monthly',
      next_due_date: '2099-01-01',
    });
    expect(res.status).toBe(201);
    expect(res.json.amount).toBe(-out);
    const rules = (await op('budget_repeat_rules_list', { budget_id: B })).json as { id: string; amount: number }[];
    expect(rules.find((r) => r.id === res.json.id)?.amount).toBe(-out);
  });

  test('category goal (categories set_target) and funding target round-trip', async () => {
    const goal = amount(2);
    expect((await op('budget_categories_set_target', { id: cat1, budget_id: B, target: { amount: goal, cadence: 'monthly' } })).status).toBe(204);
    const cats = (await op('budget_categories_list', { budget_id: B })).json as { id: string; goal_target: number }[];
    expect(cats.find((c) => c.id === cat1)?.goal_target).toBe(goal);

    // category_targets stores whole cents: milliunits that are a multiple of 10 round-trip...
    const target = amount(1); // multiple of 10
    const set = await op('budget_category_targets_set', { categoryId: cat1, budget_id: B, kind: 'monthly', amount: target, snooze_month: null });
    expect(set.status).toBe(200);
    expect(set.json.amount).toBe(target);
    const list = (await op('budget_category_targets_list', { budget_id: B })).json as { category_id: string; amount: number }[];
    expect(list.find((t) => t.category_id === cat1)?.amount).toBe(target);
    const stored = await pool.query<{ amount_cents: number }>('SELECT amount_cents FROM category_targets WHERE category_id = $1', [cat1]);
    expect(stored.rows[0].amount_cents).toBe(target / 10);
    // ...and a sub-cent value is rejected rather than silently rounded.
    const bad = await op('budget_category_targets_set', { categoryId: cat1, budget_id: B, kind: 'monthly', amount: 12_345, snooze_month: null });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('multiple of 10');
  });

  test('export (format 2, milliunits) -> restore -> export is identical, sub-cent rows included', async () => {
    const first = await op('budget_export', { budget_id: B });
    expect(first.status).toBe(200);
    expect(first.json.format_version).toBe(2);
    const live = (await op('budget_transactions_list', { budget_id: B })).json as { amount: number; upcoming: boolean }[];
    const exported = first.json.transactions as { outflow: number; inflow: number }[];
    // Every exported amount is the stored milliunit amount, sub-cent ones too.
    expect(exported.map((t) => t.inflow - t.outflow).sort((a, b) => a - b)).toEqual(
      live.filter((t) => !t.upcoming).map((t) => t.amount).sort((a, b) => a - b),
    );
    const restored = await op('budget_restore', { budget_id: R, ...first.json });
    expect(restored.status).toBe(201);
    const second = await op('budget_export', { budget_id: R });
    for (const key of ['groups', 'categories', 'accounts', 'transactions', 'assignments']) {
      expect(second.json[key], key).toEqual(first.json[key]);
    }
  });
});
