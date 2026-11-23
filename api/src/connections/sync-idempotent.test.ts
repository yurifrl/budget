/**
 * The bank import is idempotent (budget-1iym): the shadow key
 * (provider, external_transaction_id) is global, so a bank id already imported
 * anywhere (deleted by the user, tombstoned by a sync, or living in another
 * account after an unlink + relink) is skipped and counted, never inserted
 * twice; one bad row rolls back alone and the rest of the sync commits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import * as store from './store';
import { emptySyncResult, syncConnectionTransactions } from './sync';
import type { AggregatedTransaction, BankAggregator } from './types';

const PROVIDER = 'testprovider-idempotent';
const userId = crypto.randomUUID();
const budgetId = crypto.randomUUID();
const otherBudgetId = crypto.randomUUID();
const oldAccountId = crypto.randomUUID();
const newAccountId = crypto.randomUUID();
const otherBudgetAccountId = crypto.randomUUID();
const EXTERNAL_ACCOUNT = 'up-acc-idem-1';
const EXTERNAL_ITEM = 'up-item-idem-1';
const today = () => new Date().toISOString().slice(0, 10);

let upstream: AggregatedTransaction[] = [];
const aggregator = {
  environment: 'production',
  listExternalAccounts: async () => [],
  fetchInstitution: async () => null,
  getItemState: async () => ({ status: 'connected' as const, lastUpdatedAt: null }),
  listTransactions: async () => ({ transactions: upstream.map((t) => ({ ...t })), hasMore: false }),
} as unknown as BankAggregator;

const up = (externalId: string, amount = -10000, description = `Desc ${externalId}`): AggregatedTransaction => ({
  externalId,
  externalAccountId: EXTERNAL_ACCOUNT,
  description,
  amount,
  date: today(),
  currencyCode: 'BRL',
  cleared: false,
  raw: { id: externalId },
});

let connectionId = '';
const sync = () => syncConnectionTransactions({ userId, connectionId, aggregator, ignoreWatermark: true });

const link = async (accountId: string) => {
  await pool.query('UPDATE public.accounts SET connection_id = NULL, external_account_id = NULL WHERE connection_id = $1', [connectionId]);
  await pool.query('UPDATE public.accounts SET connection_id = $1, external_account_id = $2 WHERE id = $3', [
    connectionId,
    EXTERNAL_ACCOUNT,
    accountId,
  ]);
};

/** Every transaction row (any account, any state) imported for a bank id. */
const rowsFor = async (externalId: string) =>
  (
    await pool.query<{ id: string; account_id: string; deleted: boolean; amount: string }>(
      `SELECT id, account_id, deleted, amount FROM public.transactions WHERE import_id = $1 ORDER BY created_at`,
      [`${PROVIDER}:${externalId}`],
    )
  ).rows;

const shadowCount = async (externalId: string) =>
  Number(
    (
      await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM public.connection_transactions WHERE provider = $1 AND external_transaction_id = $2',
        [PROVIDER, externalId],
      )
    ).rows[0]!.n,
  );

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
  await pool.query('DELETE FROM public.budgets WHERE id = ANY($1)', [[budgetId, otherBudgetId]]);
  await pool.query('DELETE FROM public.connections WHERE provider = $1', [PROVIDER]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, $2, 'sync-idem@syscd.local', 'user', 'active')`,
    [userId, userId],
  );
  await pool.query('INSERT INTO public.budgets (id, name, owner_user_id) VALUES ($1, $2, $3), ($4, $5, $3)', [
    budgetId,
    'sync-idempotent',
    userId,
    otherBudgetId,
    'sync-idempotent-other',
  ]);
  await pool.query(
    `INSERT INTO public.accounts (id, budget_id, name, type, account_group) VALUES
       ($1, $2, 'Itaú conta (old)', 'checking', 'CASH'),
       ($3, $2, 'Itaú conta', 'checking', 'CASH'),
       ($4, $5, 'Elsewhere', 'checking', 'CASH')`,
    [oldAccountId, budgetId, newAccountId, otherBudgetAccountId, otherBudgetId],
  );
  const conn = await store.upsertConnection({
    userId,
    provider: PROVIDER,
    externalId: EXTERNAL_ITEM,
    clientUserId: `cu-${userId}`,
    status: 'connected',
    environment: 'production',
  });
  connectionId = conn.id;
  await link(oldAccountId);
});

afterAll(async () => {
  if (dbReady) await cleanup();
});

describe.skipIf(!dbReady)('connections sync is idempotent', () => {
  test('running the same sync twice is a no-op', async () => {
    upstream = [up('i1'), up('i2'), up('i3')];
    expect((await sync()).added).toBe(3);
    expect(await sync()).toEqual({ ...emptySyncResult(), duplicates: 3 });
    for (const id of ['i1', 'i2', 'i3']) expect(await rowsFor(id)).toHaveLength(1);
    await expectLedgerConsistent(oldAccountId);
  });

  test('a transaction the user deleted comes back upstream: skipped, stays deleted', async () => {
    const [row] = await rowsFor('i1');
    // The user deletes the row in the register (soft delete + balance move, as the API does).
    await pool.query('UPDATE public.transactions SET deleted = true WHERE id = $1', [row!.id]);
    await pool.query('UPDATE public.accounts SET uncleared_balance = uncleared_balance - $2 WHERE id = $1', [
      oldAccountId,
      row!.amount,
    ]);

    const result = await sync();
    expect(result).toEqual({ ...emptySyncResult(), duplicates: 2, skipped_deleted: 1 });
    const rows = await rowsFor('i1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted).toBe(true);
    expect(await shadowCount('i1')).toBe(1);
    // Twice in a row: still the same.
    expect(await sync()).toEqual(result);
    await expectLedgerConsistent(oldAccountId);
  });

  test('a row the sync tombstoned comes back upstream: skipped, stays deleted', async () => {
    upstream = [up('i1'), up('i3')];
    expect((await sync()).deleted).toBe(1); // i2 left the bank: tombstoned
    expect((await rowsFor('i2'))[0]!.deleted).toBe(true);

    upstream = [up('i1'), up('i2'), up('i3')];
    const result = await sync();
    expect(result).toEqual({ ...emptySyncResult(), duplicates: 1, skipped_deleted: 2 });
    expect(await rowsFor('i2')).toHaveLength(1);
    expect((await rowsFor('i2'))[0]!.deleted).toBe(true);
    await expectLedgerConsistent(oldAccountId);
  });

  test('rows of an old unlinked account stay there when the bank account is relinked elsewhere', async () => {
    // A row of this bank account that ended up in another budget's account.
    upstream = [up('i1'), up('i2'), up('i3'), up('i4')];
    await sync(); // i4 imported into the old account
    const [i4] = await rowsFor('i4');
    await pool.query('UPDATE public.transactions SET account_id = $2, budget_id = $3 WHERE id = $1', [
      i4!.id,
      otherBudgetAccountId,
      otherBudgetId,
    ]);
    // Move its balance along with it (uncleared, as imported).
    await pool.query('UPDATE public.accounts SET uncleared_balance = uncleared_balance - $2 WHERE id = $1', [oldAccountId, i4!.amount]);
    await pool.query('UPDATE public.accounts SET uncleared_balance = uncleared_balance + $2 WHERE id = $1', [
      otherBudgetAccountId,
      i4!.amount,
    ]);

    // Unlink the old account (rows and shadows stay) and link the new one.
    await link(newAccountId);
    upstream = [up('i1'), up('i2'), up('i3'), up('i4'), up('i5')];
    const result = await sync();
    expect(result).toEqual({
      ...emptySyncResult(),
      added: 1,
      skipped_deleted: 2,
      skipped_other_account: 2,
      skipped_accounts: [
        { account_id: oldAccountId, name: 'Itaú conta (old)', count: 1 },
        { account_id: otherBudgetAccountId, name: null, count: 1 },
      ],
    });
    expect((await rowsFor('i3')).map((r) => [r.account_id, r.deleted])).toEqual([[oldAccountId, false]]);
    expect((await rowsFor('i4')).map((r) => r.account_id)).toEqual([otherBudgetAccountId]);
    expect((await rowsFor('i5')).map((r) => r.account_id)).toEqual([newAccountId]);

    // Again: i5 is now a duplicate, the rest still skipped.
    const again = await sync();
    expect(again).toEqual({ ...result, added: 0, duplicates: 1 });
    await expectLedgerConsistent(newAccountId);
    await expectLedgerConsistent(oldAccountId);
  });

  test('one bad row does not block the others, and the sweep spares its target', async () => {
    // b-bad: bigint overflow fails the INSERT after its payee was created
    // inside the row's savepoint; b-ok shares that payee name, so it only
    // imports if the resolver forgot the rolled-back payee.
    upstream = [
      up('i5'),
      up('b-bad', 1e30, 'Shared Payee'),
      up('b-ok', -2500, 'Shared Payee'),
      up('b-ok-2', -1500),
    ];
    const result = await sync();
    expect(result.added).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.deleted).toBe(0); // i5 is live and listed: never swept
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.external_id).toBe('b-bad');
    expect(await rowsFor('b-bad')).toHaveLength(0);
    expect(await shadowCount('b-bad')).toBe(0);
    expect(await rowsFor('b-ok')).toHaveLength(1);
    expect(await rowsFor('b-ok-2')).toHaveLength(1);
    expect((await rowsFor('i5'))[0]!.deleted).toBe(false);
    await expectLedgerConsistent(newAccountId);

    // The connection watermark moved: the run committed.
    const conn = await store.getConnectionById(connectionId);
    expect(conn!.last_synced_at).not.toBeNull();
  });
});
