/**
 * Old backups still restore (phase 5d). `fixtures/syscd-backup-v1.json` was
 * produced by the ORIGINAL export code (this repo at 08ff6fd, byte-identical
 * to syscd-app's `server/budget/routes/budget-export.ts`) from the seeded
 * "Trabalho" dev budget: amounts in CENTS, no `format_version` key.
 *
 * Restoring it must store exactly cents x 10, and must land the same rows as
 * the equivalent format-2 (milliunit) document. The export afterwards is
 * format 2 and carries the same transactions scaled to milliunits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts } from '@shared/contracts/budget';
import { pool } from '../../core/db';
import { dbReady } from '../../core/test-gate';
import { makeOpCaller } from '../../core/test-op';
import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';
import budget from '..';
import legacy from './fixtures/syscd-backup-v1.json';

interface V1Txn {
  accountIndex: number;
  outflow: number;
  inflow: number;
  date: string;
  memo: string;
}

const user: IdentityUser = {
  id: crypto.randomUUID(),
  email: 'legacy-restore@legacyrestore.test',
  googleSub: null,
  role: 'user',
  status: 'active',
};
const V1 = crypto.randomUUID();
const V1_EXPLICIT = crypto.randomUUID();
const V2 = crypto.randomUUID();

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE id = ANY($1)', [[V1, V1_EXPLICIT, V2]]);
  await pool.query(`DELETE FROM public.users WHERE email LIKE '%@legacyrestore.test'`);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, 'user')`, [user.id, user.email]);
  for (const id of [V1, V1_EXPLICIT, V2]) {
    await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'legacy-restore', $2)`, [id, user.id]);
    await pool.query(`INSERT INTO budget_members (budget_id, user_id) VALUES ($1, $2)`, [id, user.id]);
  }
});
afterAll(async () => {
  if (dbReady) await cleanup();
});

/** Ledger state of a budget, independent of generated ids. */
async function snapshot(budgetId: string) {
  const txns = await pool.query<{ account: string; date: string; amount: number; memo: string | null; cleared: string }>(
    `SELECT a.name AS account, t.date::text AS date, t.amount, t.memo, t.cleared::text AS cleared
       FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.budget_id = $1 AND NOT t.deleted
      ORDER BY a.name, t.date, t.amount, t.memo`,
    [budgetId],
  );
  const assignments = await pool.query<{ category: string; month: string; budgeted: number }>(
    `SELECT c.name AS category, x.month::text AS month, x.budgeted
       FROM assignments x JOIN categories c ON c.id = x.category_id
      WHERE x.budget_id = $1 ORDER BY c.name, x.month`,
    [budgetId],
  );
  const accounts = await pool.query<{ name: string; cleared_balance: number; uncleared_balance: number }>(
    'SELECT name, cleared_balance, uncleared_balance FROM accounts WHERE budget_id = $1 AND NOT deleted ORDER BY name',
    [budgetId],
  );
  return { txns: txns.rows, assignments: assignments.rows, accounts: accounts.rows };
}

describe.skipIf(!dbReady)('restore: a legacy (cents) backup from the original format', () => {
  test('the fixture is the original format: no format_version, cents amounts', () => {
    expect('format_version' in legacy).toBe(false);
    expect(legacy.transactions.length).toBe(105);
  });

  test('restores and stores exactly cents x 10', async () => {
    const res = await op('budget_restore', { budget_id: V1, ...legacy });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ transactions: 105, assignments: legacy.assignments.length });

    const snap = await snapshot(V1);
    const expectedAmounts = (legacy.transactions as V1Txn[]).map((t) => (t.inflow - t.outflow) * 10).sort((a, b) => a - b);
    expect(snap.txns.map((t) => t.amount).sort((a, b) => a - b)).toEqual(expectedAmounts);
    expect(snap.assignments.map((a) => a.budgeted).sort((a, b) => a - b)).toEqual(
      legacy.assignments.map((a) => a.budgeted * 10).sort((a, b) => a - b),
    );
    // Balances are recomputed from the restored ledger, per account, in milliunits.
    const perAccount = new Map<string, number>();
    for (const t of legacy.transactions as V1Txn[]) {
      const name = legacy.accounts[t.accountIndex]!.name;
      perAccount.set(name, (perAccount.get(name) ?? 0) + (t.inflow - t.outflow) * 10);
    }
    for (const a of snap.accounts) {
      expect(a.cleared_balance + a.uncleared_balance, a.name).toBe(perAccount.get(a.name) ?? 0);
    }
  });

  test('format_version 1, unversioned and the equivalent format-2 document land the same rows', async () => {
    const explicit = await op('budget_restore', { budget_id: V1_EXPLICIT, ...legacy, format_version: 1 });
    expect(explicit.status).toBe(201);
    const v2 = {
      ...legacy,
      format_version: 2,
      transactions: (legacy.transactions as V1Txn[]).map((t) => ({ ...t, outflow: t.outflow * 10, inflow: t.inflow * 10 })),
      assignments: legacy.assignments.map((a) => ({ ...a, budgeted: a.budgeted * 10 })),
    };
    const res = await op('budget_restore', { budget_id: V2, ...v2 });
    expect(res.status).toBe(201);
    const base = await snapshot(V1);
    expect(await snapshot(V1_EXPLICIT)).toEqual(base);
    expect(await snapshot(V2)).toEqual(base);
  });

  test('re-export is format 2 with the same transactions in milliunits', async () => {
    const out = await op('budget_export', { budget_id: V1 });
    expect(out.status).toBe(200);
    expect(out.json.format_version).toBe(2);
    expect(out.json.transactions).toEqual(
      (legacy.transactions as V1Txn[]).map((t) => ({ ...t, outflow: t.outflow * 10, inflow: t.inflow * 10 })),
    );
    expect(out.json.assignments).toEqual(legacy.assignments.map((a) => ({ ...a, budgeted: a.budgeted * 10 })));
  });

  test('an unknown format_version is rejected, never guessed', async () => {
    const res = await op('budget_restore', { budget_id: V1, ...legacy, format_version: 3 });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('format_version');
  });
});
