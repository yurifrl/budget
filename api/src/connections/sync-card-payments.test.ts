/**
 * Card-statement payment pairing through the sync path: a cash outflow and a
 * card inflow imported by one connection sync become a linked transfer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import * as store from './store';
import { syncConnectionTransactions } from './sync';
import type { AggregatedTransaction, BankAggregator } from './types';

const PROVIDER = 'testprovider';
const userId = crypto.randomUUID();
const budgetId = crypto.randomUUID();
const cash = crypto.randomUUID();
const card = crypto.randomUUID();
const EXT_ITEM = 'up-item-kekn';
const EXT_CASH = 'up-acc-kekn-cash';
const EXT_CARD = 'up-acc-kekn-card';
const today = () => new Date().toISOString().slice(0, 10);

let upstream: Record<string, AggregatedTransaction[]> = {};
const txn = (acc: string, id: string, cents: number, description: string): AggregatedTransaction => ({
  externalId: id,
  externalAccountId: acc,
  description,
  amount: cents * 10, // the port carries milliunits
  cleared: true,
  date: today(),
  currencyCode: null,
});
const aggregator = {
  environment: 'production',
  listTransactions: async (acc: string) => ({ transactions: (upstream[acc] ?? []).map((t) => ({ ...t })), hasMore: false }),
  fetchInstitution: async () => null,
} as unknown as BankAggregator;
const sync = () => syncConnectionTransactions({ userId, connectionId: connId, aggregator, ignoreWatermark: true });
let connId = '';

const rows = async () =>
  (
    await pool.query(
      `SELECT t.id, t.account_id, t.amount::int AS amount, t.cleared, t.approved, t.deleted, t.import_id,
              t.import_payee_name, t.transfer_account_id, t.transfer_transaction_id, p.name AS payee
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
       WHERE t.budget_id = $1 AND NOT t.deleted ORDER BY t.account_id, t.import_id`,
      [budgetId],
    )
  ).rows;

const suite = dbReady ? describe : describe.skip;
suite('connections sync pairs card statement payments', () => {
  beforeAll(async () => {
    await pool.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query(
      `INSERT INTO users (id, google_sub, email, role, status) VALUES ($1,$2,'kekn-sync@syscd.local','user','active')`,
      [userId, userId],
    );
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1,$2,$3)', [budgetId, 'kekn-sync', userId]);
    await pool.query(
      `INSERT INTO accounts (id, budget_id, name, type, account_group) VALUES
       ($1,$3,'Checking','checking','CASH'),($2,$3,'Itau Card','creditCard','CREDIT')`,
      [cash, card, budgetId],
    );
    const c = await store.upsertConnection({
      userId,
      provider: PROVIDER,
      externalId: EXT_ITEM,
      clientUserId: `cu-${userId}`,
      status: 'connected',
      environment: 'production',
    });
    connId = c.id;
    await pool.query('UPDATE accounts SET connection_id = $1, external_account_id = $2 WHERE id = $3', [connId, EXT_CASH, cash]);
    await pool.query('UPDATE accounts SET connection_id = $1, external_account_id = $2 WHERE id = $3', [connId, EXT_CARD, card]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  test('pairs after import, keeps bank facts, and is idempotent across re-syncs', async () => {
    upstream = {
      [EXT_CASH]: [txn(EXT_CASH, 'c1', -1_712_334, 'Pagamento de fatura Fatura Paga Personnalite')],
      [EXT_CARD]: [txn(EXT_CARD, 'k1', 1_712_334, 'Pagamento recebido')],
    };
    await sync();
    const first = await rows();
    expect(first).toHaveLength(2);
    const c1 = first.find((r) => r.account_id === cash);
    const k1 = first.find((r) => r.account_id === card);
    expect(c1.transfer_account_id).toBe(card);
    expect(c1.transfer_transaction_id).toBe(k1.id);
    expect(k1.transfer_account_id).toBe(cash);
    expect(k1.transfer_transaction_id).toBe(c1.id);
    expect(c1.amount).toBe(-17_123_340);
    expect(c1.payee).toBe('Transfer : Itau Card');
    expect(c1.import_payee_name).toBe('Pagamento de fatura Fatura Paga Personnalite');
    expect(c1.cleared).toBe('cleared');
    expect(c1.approved).toBe(false);
    const again = await sync();
    expect(again.added).toBe(0);
    expect(await rows()).toEqual(first);
    await sync();
    expect(await rows()).toEqual(first);
  });

  test('backfills rows imported before pairing existed, and a manual unlink wins on the next sync', async () => {
    await pool.query('DELETE FROM transactions WHERE budget_id = $1', [budgetId]);
    await pool.query('DELETE FROM connection_transactions WHERE external_transaction_id = ANY($1)', [['c1', 'k1']]);
    upstream = {
      [EXT_CASH]: [txn(EXT_CASH, 'c2', -50_000, 'Pagamento de fatura')],
      [EXT_CARD]: [],
    };
    await sync(); // imports the cash row alone: nothing to pair with
    expect((await rows()).every((r) => r.transfer_account_id == null)).toBe(true);
    upstream[EXT_CARD] = [txn(EXT_CARD, 'k2', 50_000, 'Pagamento recebido')];
    await sync(); // the later-arriving card row completes the pair
    const paired = await rows();
    expect(paired.every((r) => r.transfer_account_id != null)).toBe(true);

    // The user unlinks (app flow: transfer fields cleared, payee stays the
    // transfer payee); later syncs must not re-pair.
    await pool.query('UPDATE transactions SET transfer_account_id = NULL, transfer_transaction_id = NULL WHERE budget_id = $1', [budgetId]);
    await sync();
    await sync();
    expect((await rows()).every((r) => r.transfer_account_id == null && r.transfer_transaction_id == null)).toBe(true);
  });
});
