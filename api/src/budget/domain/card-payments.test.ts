import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { pool } from '../../core/db';
import { dbReady } from '../../core/test-gate';
import { linkCardPayments, matchCardPayments, type PaymentRow } from './card-payments';

let n = 0;
const row = (over: Partial<PaymentRow>): PaymentRow => ({
  id: `t${++n}`,
  budgetId: 'b1',
  accountId: 'cash1',
  accountKind: 'cash',
  onBudget: true,
  amount: -17_123_340,
  date: '2026-11-03',
  categoryId: null,
  splitCount: 0,
  transferAccountId: null,
  transferTransactionId: null,
  untouched: true,
  ...over,
});
const out = (over: Partial<PaymentRow> = {}) => row(over);
const inn = (over: Partial<PaymentRow> = {}) =>
  row({ accountId: 'card1', accountKind: 'card', amount: 17_123_340, ...over });

describe('matchCardPayments (pure)', () => {
  test('pairs one exact outflow/inflow, same day', () => {
    const a = out();
    const b = inn();
    expect(matchCardPayments([a, b])).toEqual([{ outflowId: a.id, inflowId: b.id }]);
  });
  test('pairs up to 3 days apart in either direction', () => {
    const a = out({ date: '2026-11-03' });
    const b = inn({ date: '2026-11-06' });
    expect(matchCardPayments([a, b])).toHaveLength(1);
    const c = out({ date: '2026-11-06' });
    const d = inn({ date: '2026-11-03' });
    expect(matchCardPayments([c, d])).toHaveLength(1);
  });
  test('4 days apart is not a pair', () => {
    expect(matchCardPayments([out(), inn({ date: '2026-11-07' })])).toEqual([]);
  });
  test('amount off by a cent is not a pair', () => {
    expect(matchCardPayments([out(), inn({ amount: 17_123_350 })])).toEqual([]);
  });
  test('two candidate inflows leave everything alone', () => {
    expect(matchCardPayments([out(), inn(), inn({ accountId: 'card2' })])).toEqual([]);
  });
  test('two candidate outflows leave everything alone', () => {
    expect(matchCardPayments([out(), out({ accountId: 'cash2' }), inn()])).toEqual([]);
  });
  test('one unambiguous pair is made even next to an ambiguous group', () => {
    const a = out({ amount: -5_000 });
    const b = inn({ amount: 5_000 });
    const found = matchCardPayments([a, b, out(), out({ accountId: 'cash2' }), inn()]);
    expect(found).toEqual([{ outflowId: a.id, inflowId: b.id }]);
  });
  test('already linked rows are skipped', () => {
    expect(matchCardPayments([out({ transferAccountId: 'x' }), inn()])).toEqual([]);
    expect(matchCardPayments([out(), inn({ transferTransactionId: 'x' })])).toEqual([]);
  });
  test('categorized rows are skipped', () => {
    expect(matchCardPayments([out({ categoryId: 'c' }), inn()])).toEqual([]);
    expect(matchCardPayments([out(), inn({ categoryId: 'c' })])).toEqual([]);
  });
  test('split rows are skipped', () => {
    expect(matchCardPayments([out({ splitCount: 2 }), inn()])).toEqual([]);
  });
  test('user-touched rows are skipped', () => {
    expect(matchCardPayments([out({ untouched: false }), inn()])).toEqual([]);
  });
  test('off-budget accounts are skipped', () => {
    expect(matchCardPayments([out({ onBudget: false }), inn()])).toEqual([]);
    expect(matchCardPayments([out(), inn({ onBudget: false })])).toEqual([]);
  });
  test('cash to cash equal amounts are not paired', () => {
    expect(matchCardPayments([out(), out({ accountId: 'cash2', amount: 17_123_340 })])).toEqual([]);
  });
  test('card outflow with cash inflow is not a payment', () => {
    const purchase = row({ accountId: 'card1', accountKind: 'card', amount: -17_123_340 });
    const refund = row({ accountId: 'cash1', amount: 17_123_340 });
    expect(matchCardPayments([purchase, refund])).toEqual([]);
  });
  test('different budgets are never paired', () => {
    expect(matchCardPayments([out(), inn({ budgetId: 'b2' })])).toEqual([]);
  });
  test('an "other" account kind is not a cash side', () => {
    expect(matchCardPayments([out({ accountKind: 'other' }), inn()])).toEqual([]);
  });
});

const suite = dbReady ? describe : describe.skip;

suite('linkCardPayments (db)', () => {
  const userId = crypto.randomUUID();
  const budgetId = crypto.randomUUID();
  const cash = crypto.randomUUID();
  const card = crypto.randomUUID();
  const cash2 = crypto.randomUUID();
  let seq = 0;

  const insert = async (account: string, amount: number, date: string, payee: string) => {
    const p = await pool.query<{ id: string }>(
      `INSERT INTO payees (budget_id, name) VALUES ($1, $2)
       ON CONFLICT (budget_id, name) DO UPDATE SET name = $2 RETURNING id`,
      [budgetId, payee],
    );
    const t = await pool.query<{ id: string }>(
      `INSERT INTO transactions (budget_id, account_id, date, amount, payee_id, cleared, approved, repeat, deleted,
         import_id, import_payee_name, import_payee_name_original)
       VALUES ($1,$2,$3,$4,$5,'cleared',false,'never',false,$6,$7,$7) RETURNING id`,
      [budgetId, account, date, amount, p.rows[0].id, `kekn:${++seq}`, payee],
    );
    return t.rows[0].id;
  };
  const get = async (id: string) =>
    (
      await pool.query(
        `SELECT t.transfer_account_id, t.transfer_transaction_id, t.amount::int AS amount, t.date::text AS date,
                t.cleared, t.import_id, t.import_payee_name, p.name AS payee
         FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id WHERE t.id = $1`,
        [id],
      )
    ).rows[0];
  const run = async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await linkCardPayments(c, budgetId);
      await c.query('COMMIT');
      return r;
    } finally {
      c.release();
    }
  };
  const reset = async () => {
    await pool.query('DELETE FROM transactions WHERE budget_id = $1', [budgetId]);
  };

  beforeAll(async () => {
    await pool.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query(
      `INSERT INTO users (id, google_sub, email, role, status) VALUES ($1,$2,'kekn@syscd.local','user','active')`,
      [userId, userId],
    );
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1,$2,$3)', [budgetId, 'kekn', userId]);
    await pool.query(
      `INSERT INTO accounts (id, budget_id, name, type, account_group) VALUES
       ($1,$4,'Checking','checking','CASH'),($2,$4,'Itau Card','creditCard','CREDIT'),($3,$4,'Savings','savings','CASH')`,
      [cash, card, cash2, budgetId],
    );
  });
  afterAll(async () => {
    await pool.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  test('links an imported statement payment, keeping bank facts and text', async () => {
    await reset();
    const a = await insert(cash, -17_123_340, '2026-11-03', 'Pagamento de fatura Fatura Paga Personnalite');
    const b = await insert(card, 17_123_340, '2026-11-03', 'Pagamento recebido');
    expect(await run()).toBe(1);
    const ra = await get(a);
    const rb = await get(b);
    expect(ra).toMatchObject({ transfer_account_id: card, transfer_transaction_id: b, amount: -17_123_340, cleared: 'cleared' });
    expect(rb).toMatchObject({ transfer_account_id: cash, transfer_transaction_id: a, amount: 17_123_340 });
    expect(ra.payee).toBe('Transfer : Itau Card');
    expect(rb.payee).toBe('Transfer : Checking');
    expect(ra.import_payee_name).toBe('Pagamento de fatura Fatura Paga Personnalite');
    expect(rb.import_payee_name).toBe('Pagamento recebido');
    expect(ra.import_id).toStartWith('kekn:');
  });

  test('is idempotent', async () => {
    const before = await pool.query('SELECT * FROM transactions WHERE budget_id = $1 ORDER BY id', [budgetId]);
    expect(await run()).toBe(0);
    const after = await pool.query('SELECT * FROM transactions WHERE budget_id = $1 ORDER BY id', [budgetId]);
    expect(after.rows).toEqual(before.rows);
  });

  test('leaves ambiguous matches alone and never pairs cash to cash', async () => {
    await reset();
    await insert(cash, -9_000, '2026-11-03', 'Pgto');
    await insert(cash2, -9_000, '2026-11-03', 'Pgto');
    await insert(card, 9_000, '2026-11-03', 'Pagamento recebido');
    await insert(cash, -4_000, '2026-11-03', 'TED');
    await insert(cash2, 4_000, '2026-11-03', 'TED recebido');
    expect(await run()).toBe(0);
  });

  test('a manual unlink or payee edit is not re-paired', async () => {
    await reset();
    const a = await insert(cash, -7_000, '2026-11-03', 'Pgto fatura');
    const b = await insert(card, 7_000, '2026-11-03', 'Pagamento recebido');
    expect(await run()).toBe(1);
    // The app's unlink clears both transfer fields; the payee stays "Transfer : ..." (not the bank text).
    await pool.query(
      `UPDATE transactions SET transfer_account_id = NULL, transfer_transaction_id = NULL WHERE id = ANY($1)`,
      [[a, b]],
    );
    expect(await run()).toBe(0);
    // A payee edited on an unlinked row also keeps it out.
    await reset();
    const c = await insert(cash, -6_000, '2026-11-03', 'Pgto fatura');
    await insert(card, 6_000, '2026-11-03', 'Pagamento recebido');
    await pool.query(`UPDATE transactions SET payee_id = (SELECT id FROM payees WHERE budget_id=$1 LIMIT 1) WHERE id=$2`, [budgetId, c]);
    expect(await run()).toBe(0);
  });

  test('pairs rows already imported before the step existed (backfill)', async () => {
    await reset();
    await insert(cash, -3_000, '2026-11-01', 'Pgto fatura');
    await insert(card, 3_000, '2026-11-02', 'Pagamento recebido');
    expect(await run()).toBe(1);
  });

  test('a split row is not paired', async () => {
    await reset();
    const a = await insert(cash, -2_000, '2026-11-03', 'Pgto fatura');
    await insert(card, 2_000, '2026-11-03', 'Pagamento recebido');
    await pool.query(
      `INSERT INTO subtransactions (budget_id, transaction_id, amount) VALUES ($1,$2,-1000),($1,$2,-1000)`,
      [budgetId, a],
    );
    expect(await run()).toBe(0);
  });
});
