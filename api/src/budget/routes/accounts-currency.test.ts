/**
 * G1: `accounts.currency` (migration 0100) — an ISO 4217 label, NULL = the
 * budget's currency. Accepted on create/update, returned on reads, carried
 * by fresh start and by export/restore. No amount is ever converted.
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

const user: IdentityUser = {
  id: crypto.randomUUID(),
  email: 'currency@accountcurrency.test',
  googleSub: null,
  role: 'user',
  status: 'active',
};
const B = crypto.randomUUID();
const R = crypto.randomUUID();

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE owner_user_id = $1', [user.id]);
  await pool.query(`DELETE FROM public.users WHERE email LIKE '%@accountcurrency.test'`);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, 'user')`, [user.id, user.email]);
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'currency', $2), ($3, 'currency-restore', $2)`, [
    B, user.id, R,
  ]);
  await pool.query(`INSERT INTO budget_members (budget_id, user_id) VALUES ($1, $2), ($3, $2)`, [B, user.id, R]);
});
afterAll(async () => {
  if (dbReady) await cleanup();
});

const listed = async (budgetId: string, id: string) =>
  ((await op('budget_accounts_list', { budget_id: budgetId })).json as { id: string; currency: string | null }[]).find((a) => a.id === id);

describe.skipIf(!dbReady)('accounts.currency', () => {
  let usd = '';
  let plain = '';

  test('create: omitted = null (the budget currency); a code is normalised and returned', async () => {
    const a = await op('budget_accounts_create', { budget_id: B, name: 'Plain', type: 'checking' });
    expect(a.status).toBe(201);
    plain = a.json.id;
    expect(a.json.currency).toBeNull();
    const b = await op('budget_accounts_create', { budget_id: B, name: 'Dollars', type: 'checking', currency: ' usd ', balance: 5_000 });
    expect(b.status).toBe(201);
    usd = b.json.id;
    expect(b.json.currency).toBe('USD');
    expect((await listed(B, usd))?.currency).toBe('USD');
    // No conversion: the opening balance is stored exactly as sent.
    expect(b.json.uncleared_balance).toBe(5_000);
  });

  test('update: set, clear with null, reject a non-ISO code', async () => {
    expect((await op('budget_accounts_update', { id: plain, budget_id: B, currency: 'EUR' })).json.currency).toBe('EUR');
    expect((await op('budget_accounts_update', { id: plain, budget_id: B, currency: null })).json.currency).toBeNull();
    const bad = await op('budget_accounts_update', { id: plain, budget_id: B, currency: 'US' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('currency');
    expect((await listed(B, plain))?.currency).toBeNull();
  });

  test('the database CHECK backs the contract', async () => {
    await expect(pool.query("UPDATE accounts SET currency = 'usd' WHERE id = $1", [plain])).rejects.toThrow(/accounts_currency_iso4217/);
  });

  test('a closed account rejects a currency change until reopened', async () => {
    expect((await op('budget_accounts_update', { id: plain, budget_id: B, closed: true })).status).toBe(200);
    expect((await op('budget_accounts_update', { id: plain, budget_id: B, currency: 'GBP' })).status).toBe(409);
    expect((await op('budget_accounts_update', { id: plain, budget_id: B, closed: false })).status).toBe(200);
  });

  test('export carries currency and restore applies it', async () => {
    const exported = await op('budget_export', { budget_id: B });
    expect(exported.json.accounts).toEqual(
      expect.arrayContaining([
        { name: 'Dollars', userId: null, currency: 'USD' },
        { name: 'Plain', userId: null, currency: null },
      ]),
    );
    expect((await op('budget_restore', { budget_id: R, ...exported.json })).status).toBe(201);
    const restored = (await op('budget_accounts_list', { budget_id: R })).json as { name: string; currency: string | null }[];
    expect(restored.find((a) => a.name === 'Dollars')?.currency).toBe('USD');
    expect(restored.find((a) => a.name === 'Plain')?.currency).toBeNull();
  });

  test('fresh start copies the currency to the replacement budget', async () => {
    const res = await op('budget_fresh_start', { budget_id: B });
    expect(res.status).toBe(200);
    const newId = (res.json.created ?? res.json.budget ?? res.json).id as string;
    const accounts = (await op('budget_accounts_list', { budget_id: newId })).json as { name: string; currency: string | null }[];
    expect(accounts.find((a) => a.name === 'Dollars')?.currency).toBe('USD');
  });
});
