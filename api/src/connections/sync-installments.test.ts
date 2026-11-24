/**
 * Card installments end to end (budget-lubt): the sync skips Itaú's PENDING
 * copy of an installment already POSTED (after an early payment), and the
 * register list derives the not-yet-billed installments as upcoming rows that
 * move no balance and vanish once the real installment is imported.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts } from '@shared/contracts/budget';
import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { makeOpCaller } from '../core/test-op';
import { httpOnError } from '../core/validate';
import type { IdentityUser } from '../user';
import budget from '../budget';
import * as store from './store';
import { syncConnectionTransactions } from './sync';
import type { AggregatedTransaction, BankAggregator } from './types';

const user: IdentityUser = {
  id: crypto.randomUUID(),
  email: 'lubt-sync@installments.test',
  googleSub: null,
  role: 'user',
  status: 'active',
};
const budgetId = crypto.randomUUID();
const card = crypto.randomUUID();
const EXT_ITEM = `up-item-lubt-${crypto.randomUUID()}`;
const EXT_CARD = 'up-acc-lubt-card';

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);

/** A Pluggy card row: amount in milliunits, installment metadata as Itaú sends it. */
const inst = (
  id: string,
  description: string,
  date: string,
  milli: number,
  n: number,
  total: number,
  purchaseDate: string,
  status: 'POSTED' | 'PENDING' = 'POSTED',
): AggregatedTransaction => ({
  externalId: id,
  externalAccountId: EXT_CARD,
  description,
  amount: milli,
  cleared: status === 'POSTED',
  date,
  currencyCode: 'BRL',
  raw: {
    id,
    description,
    status,
    amount: -milli / 1000,
    creditCardMetadata: {
      installmentNumber: n,
      totalInstallments: total,
      purchaseDate: `${purchaseDate}T00:00:00.000Z`,
      billId: status === 'POSTED' ? 'bill-1' : null,
      totalAmount: null,
    },
  },
});

let upstream: AggregatedTransaction[] = [];
const aggregator = {
  environment: 'production',
  listTransactions: async () => ({ transactions: upstream.map((t) => ({ ...t })), hasMore: false }),
  fetchInstitution: async () => null,
} as unknown as BankAggregator;
let connId = '';
const sync = () => syncConnectionTransactions({ userId: user.id, connectionId: connId, aggregator, ignoreWatermark: true });

const list = async () => {
  const res = await op('budget_transactions_list', { budget_id: budgetId });
  expect(res.status).toBe(200);
  return res.json as Array<Record<string, unknown> & { id: string; upcoming: boolean; installment?: { number: number; total: number } }>;
};
const derived = async () => (await list()).filter((r) => r.installment != null);
const balances = async () =>
  (
    await pool.query<{ cleared: number; uncleared: number }>(
      'SELECT cleared_balance::int AS cleared, uncleared_balance::int AS uncleared FROM accounts WHERE id = $1',
      [card],
    )
  ).rows[0]!;

const ACADEMIA_1 = inst('a1', 'ACADEMIA ACQUA 01/12', '2026-10-05', -150_000, 1, 12, '2026-09-28');
const ACADEMIA_2 = inst('a2', 'ACADEMIA ACQUA 02/12', '2026-11-05', -150_000, 2, 12, '2026-09-28');
const PORTO_POSTED = inst('p4', 'PortovalleAcabame 04/04', '2026-09-06', -13_339_130, 4, 4, '2026-06-02');
const PORTO_PHANTOM = inst('p4-pending', 'PortovalleAcabame 04/04', '2026-11-05', -13_339_130, 4, 4, '2026-06-02', 'PENDING');
const CLINICA_1 = inst('c1', 'CCT CLINICA CIR 01/04', '2026-12-05', -80_000, 1, 4, '2026-11-20', 'PENDING');

const suite = dbReady ? describe : describe.skip;
suite('card installments: phantom pending skip + derived upcoming rows', () => {
  beforeAll(async () => {
    await pool.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
    await pool.query(`DELETE FROM users WHERE email LIKE '%@installments.test'`);
    await pool.query(`INSERT INTO users (id, email, role, status) VALUES ($1, $2, 'user', 'active')`, [user.id, user.email]);
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [budgetId, 'lubt', user.id]);
    await pool.query('INSERT INTO budget_members (budget_id, user_id) VALUES ($1, $2)', [budgetId, user.id]);
    await pool.query(
      `INSERT INTO accounts (id, budget_id, name, type, account_group) VALUES ($1, $2, 'Itau Card', 'creditCard', 'CREDIT')`,
      [card, budgetId],
    );
    const c = await store.upsertConnection({
      userId: user.id,
      provider: 'testprovider',
      externalId: EXT_ITEM,
      clientUserId: `cu-${user.id}`,
      status: 'connected',
      environment: 'production',
    });
    connId = c.id;
    await pool.query('UPDATE accounts SET connection_id = $1, external_account_id = $2 WHERE id = $3', [connId, EXT_CARD, card]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
    await pool.query('DELETE FROM connections WHERE id = $1', [connId]);
    await pool.query(`DELETE FROM users WHERE email LIKE '%@installments.test'`);
  });

  test('a PENDING copy of an installment already POSTED is skipped, on every sync', async () => {
    upstream = [ACADEMIA_1, ACADEMIA_2, PORTO_POSTED, PORTO_PHANTOM, CLINICA_1];
    const first = await sync();
    expect(first.added).toBe(4);
    expect(first.skipped_paid_installment).toBe(1);
    const again = await sync();
    expect(again.added).toBe(0);
    expect(again.skipped_paid_installment).toBe(1);
    const imported = await pool.query<{ import_id: string }>(
      'SELECT import_id FROM transactions WHERE account_id = $1 AND NOT deleted ORDER BY import_id',
      [card],
    );
    expect(imported.rows.map((r) => r.import_id)).toEqual([
      'testprovider:a1',
      'testprovider:a2',
      'testprovider:c1',
      'testprovider:p4',
    ]);
  });

  test('the PENDING installment of another purchase (other purchase date) is not a phantom', async () => {
    const other = inst('p4-other', 'PortovalleAcabame 04/04', '2026-11-05', -500_000, 4, 4, '2026-07-15', 'PENDING');
    upstream = [ACADEMIA_1, ACADEMIA_2, PORTO_POSTED, PORTO_PHANTOM, CLINICA_1, other];
    const res = await sync();
    expect(res.added).toBe(1);
    expect(res.skipped_paid_installment).toBe(1);
    // Complete purchases project nothing: drop it again to keep the next asserts small.
    upstream = [ACADEMIA_1, ACADEMIA_2, PORTO_POSTED, PORTO_PHANTOM, CLINICA_1];
    await sync();
  });

  test('the list derives the remaining installments as upcoming rows that move no balance', async () => {
    const before = await balances();
    const rows = await derived();
    // ACADEMIA 03..12 (10) + CCT 02..04 (3); PortovalleAcabame 04/04 is complete.
    expect(rows).toHaveLength(13);
    expect(rows.every((r) => r.upcoming === true && r.account_id === card && r.approved === true)).toBe(true);
    const academia3 = rows.find((r) => r.payee_name === 'ACADEMIA ACQUA 03/12');
    expect(academia3).toMatchObject({ date: '2026-12-05', amount: -150_000, installment: { number: 3, total: 12 }, cleared: 'uncleared' });
    expect(String(academia3!.id)).toMatch(/^installment:[0-9a-f-]+:3$/);
    expect(rows.filter((r) => String(r.payee_name).startsWith('CCT CLINICA CIR')).map((r) => [r.payee_name, r.date])).toEqual([
      ['CCT CLINICA CIR 04/04', '2027-03-05'],
      ['CCT CLINICA CIR 03/04', '2027-02-05'],
      ['CCT CLINICA CIR 02/04', '2027-01-05'],
    ]);
    // Newest first across stored and derived rows.
    const dates = (await list()).map((r) => String(r.date).slice(0, 10));
    expect([...dates].sort().reverse()).toEqual(dates);
    // Nothing stored: balances are what the four imported rows made them.
    expect(await balances()).toEqual(before);
    expect(before.cleared + before.uncleared).toBe(-150_000 * 2 - 13_339_130 - 80_000);
  });

  test('a newly imported installment replaces its placeholder; nothing to clean up', async () => {
    upstream = [ACADEMIA_1, ACADEMIA_2, PORTO_POSTED, PORTO_PHANTOM, CLINICA_1, inst('a3', 'ACADEMIA ACQUA 03/12', '2026-12-05', -150_000, 3, 12, '2026-09-28', 'PENDING')];
    expect((await sync()).added).toBe(1);
    const academia = (await derived()).filter((r) => String(r.payee_name).startsWith('ACADEMIA'));
    expect(academia).toHaveLength(9);
    expect(academia.map((r) => r.installment!.number).sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(academia.find((r) => r.installment!.number === 4)).toMatchObject({ date: '2027-01-05' });
  });

  test('deleting every row of a purchase stops its projection', async () => {
    await pool.query(`UPDATE transactions SET deleted = true WHERE account_id = $1 AND import_id = 'testprovider:c1'`, [card]);
    expect((await derived()).some((r) => String(r.payee_name).startsWith('CCT'))).toBe(false);
  });
});
