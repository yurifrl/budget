/**
 * Transfers between own accounts through the sync path (budget-mit6): PIX
 * between two checking accounts, ordinal pairing of repeats with Pluggy hints,
 * a payee "treat as transfer" rule whose other side arrives on a later sync,
 * and idempotent backfill.
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
const itau = crypto.randomUUID();
const nubank = crypto.randomUUID();
const EXT_ITEM = `up-item-mit6-${userId}`;
const EXT_ITAU = 'up-acc-mit6-itau';
const EXT_NU = 'up-acc-mit6-nubank';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

let upstream: Record<string, AggregatedTransaction[]> = {};
const txn = (
  acc: string,
  id: string,
  milli: number,
  description: string,
  raw: Record<string, unknown> = {},
  date = daysAgo(1),
): AggregatedTransaction => ({
  externalId: id,
  externalAccountId: acc,
  description,
  amount: milli,
  cleared: true,
  date,
  currencyCode: null,
  raw: { id, date: `${date}T12:00:00.000Z`, ...raw },
});
const SAME_PERSON = { category: 'Same person transfer', operationType: 'PIX' };
const PIX = { category: 'Transfer - PIX', operationType: 'PIX' };
const aggregator = {
  environment: 'production',
  listTransactions: async (acc: string) => ({ transactions: (upstream[acc] ?? []).map((t) => ({ ...t })), hasMore: false }),
  fetchInstitution: async () => null,
} as unknown as BankAggregator;
let connId = '';
const sync = () => syncConnectionTransactions({ userId, connectionId: connId, aggregator, ignoreWatermark: true });

const rows = async () =>
  (
    await pool.query(
      `SELECT t.id, t.account_id, t.amount::int AS amount, t.import_id, t.import_payee_name,
              t.transfer_account_id, t.transfer_transaction_id, p.name AS payee, l.method
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN transfer_links l ON l.transaction_id = t.id
       WHERE t.budget_id = $1 AND NOT t.deleted ORDER BY t.account_id, t.import_id`,
      [budgetId],
    )
  ).rows;
const reset = async () => {
  await pool.query('DELETE FROM transactions WHERE budget_id = $1', [budgetId]);
  await pool.query('DELETE FROM connection_transactions WHERE budget_id = $1', [budgetId]);
  await pool.query('UPDATE payees SET transfer_rule = NULL WHERE budget_id = $1', [budgetId]);
};

const suite = dbReady ? describe : describe.skip;
suite('connections sync links transfers between own accounts', () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (id, google_sub, email, role, status) VALUES ($1,$2,'mit6-sync@syscd.local','user','active')`,
      [userId, userId],
    );
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1,$2,$3)', [budgetId, 'mit6-sync', userId]);
    await pool.query(
      `INSERT INTO accounts (id, budget_id, name, type, account_group) VALUES
       ($1,$3,'Itau Conta','checking','CASH'),($2,$3,'Nubank Conta','checking','CASH')`,
      [itau, nubank, budgetId],
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
    // One connection, two banks: the account labels tell them apart (budget-zkts:
    // checking to checking pairs only across banks; the same connection
    // without labels would count as one bank).
    await pool.query('UPDATE accounts SET connection_id = $1, external_account_id = $2, institution = $4 WHERE id = $3', [connId, EXT_ITAU, itau, 'itau']);
    await pool.query('UPDATE accounts SET connection_id = $1, external_account_id = $2, institution = $4 WHERE id = $3', [
      connId,
      EXT_NU,
      nubank,
      'Nu Pagamentos S.A.',
    ]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  test('a PIX between two own checking accounts is linked, and re-syncs leave it as is', async () => {
    await reset();
    upstream = {
      [EXT_ITAU]: [txn(EXT_ITAU, 'i1', -3_000_000, 'Pix enviado Yuri freire lima', SAME_PERSON)],
      [EXT_NU]: [txn(EXT_NU, 'n1', 3_000_000, 'Transferência Recebida|YURI FREIRE LIMA', SAME_PERSON)],
    };
    await sync();
    const first = await rows();
    const out = first.find((r) => r.account_id === itau);
    const inn = first.find((r) => r.account_id === nubank);
    expect(out).toMatchObject({ transfer_account_id: nubank, transfer_transaction_id: inn.id, payee: 'Transfer : Nubank Conta', method: 'auto' });
    expect(inn).toMatchObject({ transfer_account_id: itau, transfer_transaction_id: out.id, payee: 'Transfer : Itau Conta', method: 'auto' });
    expect(out.import_payee_name).toBe('Pix enviado Yuri freire lima');
    await sync();
    await sync();
    expect(await rows()).toEqual(first);
  });

  test('repeated equal amounts on the same days pair in bank-time order when Pluggy says transfer', async () => {
    await reset();
    const d = daysAgo(3);
    upstream = {
      [EXT_ITAU]: [
        txn(EXT_ITAU, 'i2', -100_000, 'Pix enviado', { ...PIX, date: `${d}T09:00:00Z` }, d),
        txn(EXT_ITAU, 'i3', -100_000, 'Pix enviado', { ...PIX, date: `${d}T15:00:00Z` }, d),
      ],
      [EXT_NU]: [
        txn(EXT_NU, 'n2', 100_000, 'Transferência Recebida', { ...PIX, date: `${d}T09:00:04Z` }, d),
        txn(EXT_NU, 'n3', 100_000, 'Transferência Recebida', { ...PIX, date: `${d}T15:00:02Z` }, d),
      ],
    };
    await sync();
    const all = await rows();
    const id = (imp: string) => all.find((r) => r.import_id.endsWith(imp)).id;
    expect(all.find((r) => r.id === id('i2')).transfer_transaction_id).toBe(id('n2'));
    expect(all.find((r) => r.id === id('i3')).transfer_transaction_id).toBe(id('n3'));
  });

  test('a payee rule: the row waits for its other side, which links on a later sync', async () => {
    await reset();
    upstream = { [EXT_ITAU]: [txn(EXT_ITAU, 'i4', -350_000, 'Pix enviado Yuri freire lima', { category: 'Transfers' })], [EXT_NU]: [] };
    // The rule exists before the row is imported (as after "Always treat as transfer").
    await pool.query(
      `INSERT INTO payees (budget_id, name, transfer_rule, transfer_rule_since) VALUES ($1, 'Pix enviado Yuri freire lima', 'auto', now() - interval '1 minute')
       ON CONFLICT (budget_id, name) DO UPDATE SET transfer_rule = 'auto', transfer_rule_since = now() - interval '1 minute'`,
      [budgetId],
    );
    await sync();
    expect((await rows()).every((r) => r.transfer_transaction_id == null)).toBe(true);
    // The other side is a different, edited-looking text (no evidence): the rule still links it.
    upstream[EXT_NU] = [txn(EXT_NU, 'n4', 350_000, 'TED recebido', {})];
    await sync();
    const linked = await rows();
    expect(linked).toHaveLength(2);
    expect(linked.every((r) => r.transfer_transaction_id != null && r.method === 'rule')).toBe(true);
  });
});
