/**
 * Budgets are isolated (budget-mwp0): bank-id identity is per budget. The
 * same bank transaction imports into every budget whose account is fed by it;
 * only a copy in the SAME budget (deleted, or in another of its accounts)
 * makes the sync skip. Production regression (v2026.11.23): a bank account
 * linked in a second budget skipped every row as "already imported in another
 * budget", because the shadow key (provider, external_transaction_id) was
 * global. DB-gated.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import * as store from './store';
import { emptySyncResult, syncConnectionTransactions } from './sync';
import type { AggregatedTransaction, BankAggregator } from './types';

const PROVIDER = 'testprovider-per-budget';
const EXTERNAL_ACCOUNT = 'up-acc-per-budget';
const userId = crypto.randomUUID();
const budgetA = crypto.randomUUID();
const budgetB = crypto.randomUUID();
const budgetC = crypto.randomUUID();
const accA1 = crypto.randomUUID();
const accA2 = crypto.randomUUID();
const accB1 = crypto.randomUUID();
const accC1 = crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);

let upstream: AggregatedTransaction[] = [];
const aggregator = {
  environment: 'production',
  listExternalAccounts: async () => [],
  fetchInstitution: async () => null,
  getItemState: async () => ({ status: 'connected' as const, lastUpdatedAt: null }),
  listTransactions: async () => ({ transactions: upstream.map((t) => ({ ...t })), hasMore: false }),
} as unknown as BankAggregator;

const up = (externalId: string, amount = -10000): AggregatedTransaction => ({
  externalId,
  externalAccountId: EXTERNAL_ACCOUNT,
  description: `Desc ${externalId}`,
  amount,
  date: today(),
  currencyCode: 'BRL',
  cleared: false,
  raw: { id: externalId },
});

/** Two connections handing out the same bank ids, so two budgets are fed at once. */
let connA = '';
let connB = '';
const sync = (connectionId: string) => syncConnectionTransactions({ userId, connectionId, aggregator, ignoreWatermark: true });

/** Point `connectionId`'s upstream account at `accountId` (and nothing else). */
const link = async (connectionId: string, accountId: string) => {
  await pool.query('UPDATE public.accounts SET connection_id = NULL, external_account_id = NULL WHERE connection_id = $1', [connectionId]);
  await pool.query('UPDATE public.accounts SET connection_id = $1, external_account_id = $2 WHERE id = $3', [
    connectionId,
    EXTERNAL_ACCOUNT,
    accountId,
  ]);
};

/** Imported rows for a bank id, per account. */
const rowsFor = async (externalId: string) =>
  (
    await pool.query<{ id: string; account_id: string; budget_id: string; deleted: boolean; amount: string }>(
      `SELECT id, account_id, budget_id, deleted, amount FROM public.transactions
       WHERE import_id = $1 ORDER BY created_at`,
      [`${PROVIDER}:${externalId}`],
    )
  ).rows;

const liveIn = async (externalId: string, accountId: string) =>
  (await rowsFor(externalId)).filter((r) => r.account_id === accountId && !r.deleted);

const shadowBudgets = async (externalId: string) =>
  (
    await pool.query<{ budget_id: string }>(
      `SELECT budget_id FROM public.connection_transactions
       WHERE provider = $1 AND external_transaction_id = $2 ORDER BY budget_id`,
      [PROVIDER, externalId],
    )
  ).rows.map((r) => r.budget_id);

/** Cached balances must equal the live ledger (both in milliunits). */
const expectLedgerConsistent = async (accountId: string) => {
  const sum = await pool.query<{ s: string }>(
    'SELECT COALESCE(SUM(amount), 0)::text AS s FROM public.transactions WHERE account_id = $1 AND NOT deleted',
    [accountId],
  );
  const b = (
    await pool.query<{ cleared_balance: string; uncleared_balance: string }>(
      'SELECT cleared_balance, uncleared_balance FROM public.accounts WHERE id = $1',
      [accountId],
    )
  ).rows[0]!;
  expect(Number(b.cleared_balance) + Number(b.uncleared_balance)).toBe(Number(sum.rows[0]!.s));
};

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE id = ANY($1)', [[budgetA, budgetB, budgetC]]);
  await pool.query('DELETE FROM public.connections WHERE provider = $1', [PROVIDER]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, $2, 'sync-per-budget@syscd.local', 'user', 'active')`,
    [userId, userId],
  );
  await pool.query(
    `INSERT INTO public.budgets (id, name, owner_user_id) VALUES
       ($1, 'per-budget-A', $4), ($2, 'per-budget-B', $4), ($3, 'per-budget-C', $4)`,
    [budgetA, budgetB, budgetC, userId],
  );
  await pool.query(
    `INSERT INTO public.accounts (id, budget_id, name, type, account_group) VALUES
       ($1, $2, 'Itaú A', 'checking', 'CASH'),
       ($3, $2, 'Itaú A (new)', 'checking', 'CASH'),
       ($4, $5, 'Itaú B', 'checking', 'CASH'),
       ($6, $7, 'Itaú C', 'checking', 'CASH')`,
    [accA1, budgetA, accA2, accB1, budgetB, accC1, budgetC],
  );
  for (const [item, set] of [
    ['up-item-per-budget-a', (id: string) => (connA = id)],
    ['up-item-per-budget-b', (id: string) => (connB = id)],
  ] as const) {
    const conn = await store.upsertConnection({
      userId,
      provider: PROVIDER,
      externalId: item,
      clientUserId: `cu-${userId}`,
      status: 'connected',
      environment: 'production',
    });
    set(conn.id);
  }
  await link(connA, accA1);
  await link(connB, accB1);
});

afterAll(async () => {
  if (dbReady) await cleanup();
});

describe.skipIf(!dbReady)('bank-id identity is per budget', () => {
  test('two budgets fed the same bank ids both import every row; re-running is a no-op in both', async () => {
    upstream = [up('p1'), up('p2'), up('p3')];
    expect(await sync(connA)).toEqual({ ...emptySyncResult(), added: 3 });
    expect(await sync(connB)).toEqual({ ...emptySyncResult(), added: 3 });
    for (const id of ['p1', 'p2', 'p3']) {
      expect(await liveIn(id, accA1)).toHaveLength(1);
      expect(await liveIn(id, accB1)).toHaveLength(1);
      expect(await shadowBudgets(id)).toEqual([budgetA, budgetB].sort());
    }
    expect(await sync(connA)).toEqual({ ...emptySyncResult(), duplicates: 3 });
    expect(await sync(connB)).toEqual({ ...emptySyncResult(), duplicates: 3 });
    await expectLedgerConsistent(accA1);
    await expectLedgerConsistent(accB1);
  });

  test('deleting in budget A leaves budget B alone; A keeps it deleted', async () => {
    const [p1] = await liveIn('p1', accA1);
    await pool.query('UPDATE public.transactions SET deleted = true WHERE id = $1', [p1!.id]);
    await pool.query('UPDATE public.accounts SET uncleared_balance = uncleared_balance - $2 WHERE id = $1', [accA1, p1!.amount]);

    expect(await sync(connA)).toEqual({ ...emptySyncResult(), duplicates: 2, skipped_deleted: 1 });
    expect(await sync(connB)).toEqual({ ...emptySyncResult(), duplicates: 3 });
    expect(await liveIn('p1', accA1)).toHaveLength(0);
    expect(await liveIn('p1', accB1)).toHaveLength(1);
    await expectLedgerConsistent(accA1);
    await expectLedgerConsistent(accB1);
  });

  test('another account of the same budget still wins; the skip names that account', async () => {
    await link(connA, accA2);
    const result = await sync(connA);
    expect(result).toEqual({
      ...emptySyncResult(),
      skipped_deleted: 1,
      skipped_other_account: 2,
      skipped_accounts: [{ account_id: accA1, name: 'Itaú A', count: 2 }],
    });
    expect(await sync(connA)).toEqual(result);
    expect(await sync(connB)).toEqual({ ...emptySyncResult(), duplicates: 3 });
    await expectLedgerConsistent(accA2);
  });

  test('relinking the bank account into a third budget imports every row there, the deleted one too', async () => {
    upstream = [up('p1'), up('p2'), up('p3'), up('p4')];
    await link(connA, accC1);
    expect(await sync(connA)).toEqual({ ...emptySyncResult(), added: 4 });
    expect(await sync(connA)).toEqual({ ...emptySyncResult(), duplicates: 4 });
    for (const id of ['p1', 'p2', 'p3', 'p4']) expect(await liveIn(id, accC1)).toHaveLength(1);
    // Budget A was not touched by C's import.
    expect(await liveIn('p1', accA1)).toHaveLength(0);
    expect(await liveIn('p4', accA1)).toHaveLength(0);
    await expectLedgerConsistent(accC1);
  });

  test('the ledger key is unique per budget, and an insert without budget_id gets it from the transaction', async () => {
    const [p2] = await liveIn('p2', accC1);
    const shadow = (await pool.query('SELECT * FROM public.connection_transactions WHERE transaction_id = $1', [p2!.id])).rows[0];
    await pool.query('DELETE FROM public.connection_transactions WHERE transaction_id = $1', [p2!.id]);
    await pool.query(
      `INSERT INTO public.connection_transactions (transaction_id, provider, external_transaction_id, last_synced_payload)
       VALUES ($1, $2, $3, $4)`,
      [p2!.id, PROVIDER, 'p2', shadow.last_synced_payload],
    );
    expect(await shadowBudgets('p2')).toEqual([budgetA, budgetB, budgetC].sort());

    // A second transaction in budget C cannot carry the same bank id.
    const other = crypto.randomUUID();
    await pool.query(
      `INSERT INTO public.transactions (id, budget_id, account_id, date, amount, cleared, approved)
       VALUES ($1, $2, $3, $4, -1, 'uncleared', false)`,
      [other, budgetC, accC1, today()],
    );
    let code: string | undefined;
    try {
      await pool.query(
        'INSERT INTO public.connection_transactions (transaction_id, provider, external_transaction_id) VALUES ($1, $2, $3)',
        [other, PROVIDER, 'p2'],
      );
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('23505');
    await pool.query('DELETE FROM public.transactions WHERE id = $1', [other]);
  });
});
