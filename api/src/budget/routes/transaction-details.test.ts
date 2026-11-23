/**
 * GET /transactions/:id (budget_transactions_get): the detail read of one
 * transaction. A hand-entered row answers `import: null`; a bank-imported row
 * carries its sync shadow (provider, bank id, state, last synced fields, the
 * raw provider payload) plus the account's bank link; a row of another budget
 * is 404 even when the caller sends a budget they belong to.
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
  email: 'txn-details@txndetails.test',
  googleSub: null,
  role: 'user',
  status: 'active',
};
const B = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const account = crypto.randomUUID();
const otherAccount = crypto.randomUUID();
const manualTxn = crypto.randomUUID();
const importedTxn = crypto.randomUUID();
const otherTxn = crypto.randomUUID();
const category = crypto.randomUUID();
const group = crypto.randomUUID();
const payee = crypto.randomUUID();
const extId = `txn-details-${crypto.randomUUID()}`;

const raw = {
  id: extId,
  descriptionRaw: 'PADARIA DO ZE',
  status: 'POSTED',
  merchant: { name: 'Padaria', cnpj: '00.000.000/0001-00' },
  creditCardMetadata: { installmentNumber: 2, totalInstallments: 6 },
  paymentData: null,
  tags: [],
};

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE id = ANY($1)', [[B, OTHER]]);
  await pool.query(`DELETE FROM public.users WHERE email LIKE '%@txndetails.test'`);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, 'user')`, [user.id, user.email]);
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'details', $2), ($3, 'other', NULL)`, [B, user.id, OTHER]);
  await pool.query(`INSERT INTO budget_members (budget_id, user_id) VALUES ($1, $2)`, [B, user.id]);
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget, institution)
     VALUES ($1, $2, 'Card', 'checking', 'CASH', true, 'Nubank'), ($3, $4, 'Other', 'checking', 'CASH', true, NULL)`,
    [account, B, otherAccount, OTHER],
  );
  await pool.query(`INSERT INTO category_groups (id, budget_id, name, sort_order) VALUES ($1, $2, 'Food', 0)`, [group, B]);
  await pool.query(`INSERT INTO categories (id, budget_id, group_id, name, sort_order) VALUES ($1, $2, $3, 'Groceries', 0)`, [
    category, B, group,
  ]);
  await pool.query(`INSERT INTO payees (id, budget_id, name) VALUES ($1, $2, 'Padaria')`, [payee, B]);
  await pool.query(
    `INSERT INTO transactions (id, budget_id, account_id, date, amount, payee_id, category_id, memo, cleared, approved, repeat, deleted, import_id)
     VALUES ($1, $2, $3, '2026-11-20', -12340, $4, $5, 'by hand', 'uncleared', true, 'never', false, NULL),
            ($6, $2, $3, '2026-11-21', -45600, $4, NULL, NULL, 'cleared', false, 'never', false, $7),
            ($8, $9, $10, '2026-11-21', -1000, NULL, NULL, 'secret', 'uncleared', true, 'never', false, NULL)`,
    [manualTxn, B, account, payee, category, importedTxn, `pluggy:${extId}`, otherTxn, OTHER, otherAccount],
  );
  await pool.query(
    `INSERT INTO connection_transactions (transaction_id, provider, external_transaction_id, last_synced_payload, blocked, raw_payload, raw_received_at)
     VALUES ($1, 'pluggy', $2, $3, true, $4, '2026-11-21T12:00:00Z')`,
    [importedTxn, extId, JSON.stringify({ amount: -45600, payee: 'PADARIA DO ZE' }), JSON.stringify(raw)],
  );
});

afterAll(async () => {
  if (dbReady) await cleanup();
});

describe.skipIf(!dbReady)('budget_transactions_get', () => {
  test('a hand-entered row: the register row with names, import null', async () => {
    const res = await op('budget_transactions_get', { id: manualTxn, budget_id: B });
    expect(res.status).toBe(200);
    expect(res.json.import).toBeNull();
    expect(res.json.transaction).toMatchObject({
      id: manualTxn,
      date: '2026-11-20',
      amount: -12340,
      payee_name: 'Padaria',
      category_name: 'Groceries',
      account_name: 'Card',
      memo: 'by hand',
      subtransactions: [],
    });
    expect(res.json.transaction).not.toHaveProperty('account_connection_id');
  });

  test('a bank-imported row carries its import record and the raw payload untouched', async () => {
    const res = await op('budget_transactions_get', { id: importedTxn, budget_id: B });
    expect(res.status).toBe(200);
    expect(res.json.transaction.import_id).toBe(`pluggy:${extId}`);
    expect(res.json.import).toMatchObject({
      provider: 'pluggy',
      bank_transaction_id: extId,
      connection_id: null,
      bank_name: 'Nubank',
      state: 'edited',
      last_synced_payload: { amount: -45600, payee: 'PADARIA DO ZE' },
      raw,
      raw_received_at: '2026-11-21T12:00:00.000Z',
    });
  });

  test("another budget's row is 404 with the caller's own budget_id", async () => {
    const res = await op('budget_transactions_get', { id: otherTxn, budget_id: B });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.json)).not.toContain('secret');
  });

  test('an unknown id is 404', async () => {
    const res = await op('budget_transactions_get', { id: crypto.randomUUID(), budget_id: B });
    expect(res.status).toBe(404);
  });
});
