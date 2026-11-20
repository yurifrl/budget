/**
 * Tests for server/connections/sync.ts — the provider-neutral transaction
 * pull engine. Runs against Postgres with a fake aggregator (the engine talks
 * to the BankAggregator port, never an adapter module), gated on reachability
 * + migrated schema (0014) so `bun test` stays green without a live DB.
 * Fixtures self-clean: the test budget is deleted first (no cascade from
 * users), then the test users.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { HttpError } from '../core/validate';
import * as store from './store';
import { effectiveSyncWindowDays } from './settings';
import { pullFrom, refreshConnection, syncConnectionTransactions } from './sync';
import type { AggregatedTransaction, BankAggregator, ConnectTokenInput } from './types';

const PROVIDER = 'testprovider';

let dbReady = true;
try {
  await pool.query('select 1');
  await pool.query("select to_regclass('public.connections')::text is not null");
} catch {
  dbReady = false;
}

const userId = crypto.randomUUID();
const budgetId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const EXTERNAL_ACCOUNT = 'up-acc-sync-1';
const EXTERNAL_ITEM = 'up-item-sync-1';

const today = () => new Date().toISOString().slice(0, 10);

interface FakeTxn {
  txn: AggregatedTransaction;
}

/** Minimal BankAggregator fake — only listTransactions matters to the engine. */
function fakeAggregator(
  upstream: AggregatedTransaction[],
  listOverride?: BankAggregator['listTransactions'],
): BankAggregator {
  return {
    environment: 'production',
    verifyCredentials: async () => true,
    hasItem: async () => true,
    createConnectToken: async (_input: ConnectTokenInput) => ({
      token: 't',
      clientId: 'c',
      widgetUrl: 'https://widget.example',
    }),
    listExternalAccounts: async () => [],
    fetchInstitution: async () => null,
    getItemState: async () => ({ status: 'connected' as const, lastUpdatedAt: null }),
    listTransactions:
      listOverride ??
      (async (_externalAccountId: string, _window?: { from?: string; to?: string; page?: number }) => {
        return { transactions: upstream.map((t) => ({ ...t })), hasMore: false };
      }),
    deleteConnection: async () => {},
    mapWebhookDelivery: () => null,
    mapStatus: () => 'connected' as const,
    verifyWebhookHeaders: () => false,
  };
}

const txnRow = async (externalTxId: string, date: string = today()) => {
  const found = await pool.query<{
    id: string;
    date: string;
    amount: number;
    cleared: string;
    approved: boolean;
    memo: string | null;
    import_payee_name: string | null;
    deleted: boolean;
  }>(
    `SELECT t.id, t.date::text AS date, t.amount, t.cleared, t.approved, t.memo, t.import_payee_name, t.deleted
     FROM public.transactions t
     WHERE t.account_id = $1 AND t.import_id = $2 AND t.date = $3::date`,
    [accountId, `${PROVIDER}:${externalTxId}`, date],
  );
  return found.rows[0] ?? null;
};

const shadowRow = async (transactionId: string) => {
  const found = await pool.query<{ blocked: boolean; last_synced_payload: unknown; external_transaction_id: string }>(
    'SELECT blocked, last_synced_payload, external_transaction_id FROM public.connection_transactions WHERE transaction_id = $1',
    [transactionId],
  );
  return found.rows[0] ?? null;
};

const accountBalances = async () => {
  const found = await pool.query<{ cleared_balance: number; uncleared_balance: number }>(
    'SELECT cleared_balance, uncleared_balance FROM public.accounts WHERE id = $1',
    [accountId],
  );
  return found.rows[0]!;
};

const connectionRow = async () => {
  const found = await pool.query<{ id: string; last_synced_at: Date | null }>(
    'SELECT id, last_synced_at FROM public.connections WHERE external_id = $1 AND provider = $2',
    [EXTERNAL_ITEM, PROVIDER],
  );
  return found.rows[0]!;
};

const connId = async () => (await connectionRow()).id;

beforeAll(async () => {
  if (!dbReady) return;
  await pool.query('DELETE FROM public.budgets WHERE id = $1', [budgetId]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status)
     VALUES ($1, $2, 'connections-sync@syscd.local', 'user', 'active')`,
    [userId, userId],
  );
  await pool.query('INSERT INTO public.budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [
    budgetId,
    'connections-sync-test',
    userId,
  ]);
  await pool.query(
    `INSERT INTO public.accounts (id, budget_id, name, type, account_group)
     VALUES ($1, $2, 'Checking', 'checking', 'CASH')`,
    [accountId, budgetId],
  );
  await store.upsertConnection({
    userId,
    provider: PROVIDER,
    externalId: EXTERNAL_ITEM,
    clientUserId: `cu-${userId}`,
    status: 'connected',
    environment: 'production',
  });
  // Link: the budget account row carries the connection (no mirror table).
  await pool.query('UPDATE public.accounts SET connection_id = $1, external_account_id = $2 WHERE id = $3', [
    await connId(),
    EXTERNAL_ACCOUNT,
    accountId,
  ]);
});

afterAll(async () => {
  if (!dbReady) return;
  await pool.query('DELETE FROM public.budgets WHERE id = $1', [budgetId]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
});

describe('sync window semantics (pure)', () => {
  const date = (offsetDays: number): Date => new Date(Date.now() - offsetDays * 86_400_000);

  test('All history: unwatermarked pull has no floor at all', () => {
    expect(pullFrom(null, 0)).toBeNull();
  });

  test('All history: watermarked pull overlaps the watermark by one day', () => {
    const wm = date(10);
    expect(pullFrom(wm, 0)).toBe(date(11).toISOString().slice(0, 10));
  });

  test('capped window: unwatermarked pull reaches exactly N days back', () => {
    expect(pullFrom(null, 90)).toBe(date(90).toISOString().slice(0, 10));
  });

  test('capped window: fresh watermark caps the lookback at N days', () => {
    // watermark 1 day old → overlap today−2 vs floor today−90 → the LATER
    // bound (today−2) wins: lookback applies to every pull, not just the first.
    expect(pullFrom(date(1), 90)).toBe(date(2).toISOString().slice(0, 10));
  });

  test('capped window: stale watermark cannot pull shorter than the window', () => {
    // watermark 300 days old, window 90 → floor (today−90) is later, wins.
    expect(pullFrom(date(300), 90)).toBe(date(90).toISOString().slice(0, 10));
  });
});

describe('effective sync window (pure)', () => {
  test('a connection override wins, including 0 (all history); null inherits', () => {
    expect(effectiveSyncWindowDays(null, 90)).toBe(90);
    expect(effectiveSyncWindowDays(30, 90)).toBe(30);
    expect(effectiveSyncWindowDays(0, 90)).toBe(0);
  });
});

describe.skipIf(!dbReady)('connections sync', () => {
  const upTx1 = (): AggregatedTransaction => ({
    externalId: 'up-sync-tx-1',
    externalAccountId: EXTERNAL_ACCOUNT,
    description: 'Coffee Shop',
    amount: -35500,
    date: today(),
    currencyCode: 'BRL',
    cleared: false,
  });
  const upTx2 = (): AggregatedTransaction => ({
    externalId: 'up-sync-tx-2',
    externalAccountId: EXTERNAL_ACCOUNT,
    description: 'Salary',
    amount: 1000000,
    date: today(),
    currencyCode: 'BRL',
    cleared: false,
  });

  test('initial pull inserts uncleared rows, ledger entries, and bumps cached balance', async () => {
    if (!dbReady) return;
    const result = await syncConnectionTransactions({
      userId,
      connectionId: await connId(),
      aggregator: fakeAggregator([upTx1(), upTx2()]),
    });
    expect(result.added).toBe(2);

    const t1 = await txnRow('up-sync-tx-1');
    expect(t1).not.toBeNull();
    expect(t1!.amount).toBe(-35500);
    expect(t1!.cleared).toBe('uncleared');
    expect(t1!.approved).toBe(false);
    expect(t1!.deleted).toBe(false);
    expect(t1!.memo).toBeNull();
    expect(t1!.import_payee_name).toBe('Coffee Shop');

    const t2 = await txnRow('up-sync-tx-2');
    expect(t2!.amount).toBe(1000000);

    const shadow = await shadowRow(t1!.id);
    expect(shadow!.blocked).toBe(false);
    expect(shadow!.external_transaction_id).toBe('up-sync-tx-1');

    const balances = await accountBalances();
    // -35.50 + 1000.00 → signed cents × 10 in the cached milliunit balance.
    expect(balances.uncleared_balance).toBe((-3550 + 100000) * 10);
  });

  test('re-pull is idempotent — no duplicates, no balance churn', async () => {
    if (!dbReady) return;
    const before = await accountBalances();
    const result = await syncConnectionTransactions({
      userId,
      connectionId: await connId(),
      aggregator: fakeAggregator([upTx1(), upTx2()]),
    });
    expect(result).toEqual({ added: 0, updated: 0, deleted: 0, blocked: 0, duplicates: 2 });
    expect(await accountBalances()).toEqual(before);
  });

  test('refreshConnection stamps the watermark and pulls incrementally', async () => {
    if (!dbReady) return;
    const row = await store.listConnectionsByUser(userId);
    const conn = row.find((r) => r.external_id === EXTERNAL_ITEM)!;
    const seen: Array<{ from: string | undefined; to: string | undefined }> = [];
    const aggregator = fakeAggregator([upTx1(), upTx2()]);
    const originalList = aggregator.listTransactions.bind(aggregator);
    aggregator.listTransactions = async (externalAccountId, window) => {
      seen.push({ from: window?.from, to: window?.to });
      return originalList(externalAccountId, window);
    };

    const initial = await refreshConnection({ userId, connectionId: conn.id, aggregator });
    expect(initial.transactions.added).toBe(0);
    expect(initial.row.last_synced_at).not.toBeNull();

    // Incremental window starts one day before the watermark (same-day
    // edits are re-checked), not the 365-day fallback.
    expect(seen.length).toBe(1);
    expect(seen[0]!.from).toBe(
      new Date(initial.row.last_synced_at!.getTime() - 86_400_000).toISOString().slice(0, 10),
    );
  });

  test('refreshConnection backfills the institution when the row has none', async () => {
    if (!dbReady) return;
    const rows = await store.listConnectionsByUser(userId);
    const conn = rows.find((r) => r.external_id === EXTERNAL_ITEM)!;
    // Same payload as the other tests — the sync pass must stay a no-op so
    // this test leaves the ledger state untouched.
    const aggregator = fakeAggregator([upTx1(), upTx2()]);
    aggregator.fetchInstitution = async () => 'Sync Test Bank';

    const result = await refreshConnection({ userId, connectionId: conn.id, aggregator });
    expect(result.row.institution).toBe('Sync Test Bank');

    // A row that already carries a name keeps it — no rewrite churn.
    const again = await refreshConnection({ userId, connectionId: conn.id, aggregator });
    expect(again.row.institution).toBe('Sync Test Bank');
  });

  test('upstream amount change updates the row and rebalances between deltas', async () => {
    if (!dbReady) return;
    const before = await accountBalances();
    const changed = upTx1();
    changed.amount = -100000;
    const result = await syncConnectionTransactions({
      userId,
      connectionId: await connId(),
      aggregator: fakeAggregator([changed, upTx2()]),
    });
    expect(result.updated).toBe(1);
    const t1 = await txnRow('up-sync-tx-1');
    expect(t1!.amount).toBe(-100000);
    // Old contribution -3550 replaced by -10000 → delta -6450 cents × 10.
    const after = await accountBalances();
    expect(after.uncleared_balance).toBe(before.uncleared_balance - 6450 * 10);
  });

  test('bank-confirmed rows import cleared, land in the cleared bucket, and stay duplicates', async () => {
    if (!dbReady) return;
    // Upstream timestamps are ISO datetimes; the ledger stores date-only —
    // the import must normalize or the row mismatches itself on every pull.
    const posted: AggregatedTransaction = {
      externalId: 'up-sync-tx-posted-1',
      externalAccountId: EXTERNAL_ACCOUNT,
      description: 'Grocery Store',
      amount: -125000,
      date: '2026-11-05T03:00:00.000Z',
      currencyCode: 'BRL',
      cleared: true,
    };
    // The pull carries the shared fixtures too — upstream rows absent from
    // the payload are swept as tombstones, so this test must not omit them.
    // tx-1's amount sits at the amount-change test's -10000 here; re-sending
    // the original -3550 would churn the row (and its balance) downstream.
    const aggregator = fakeAggregator([posted, { ...upTx1(), amount: -100000 }, upTx2()]);
    const first = await syncConnectionTransactions({
      userId,
      connectionId: await connId(),
      aggregator,
    });
    expect(first.added).toBe(1);
    expect(first.duplicates).toBe(2);

    const row = await txnRow('up-sync-tx-posted-1', '2026-11-05');
    expect(row!.cleared).toBe('cleared');
    expect(row!.date).toBe('2026-11-05');

    const before = await accountBalances();
    // Repeat pull: the normalized shadow matches the read-back form — a
    // duplicate, not a user-modified block.
    const repeat = await syncConnectionTransactions({
      userId,
      connectionId: await connId(),
      aggregator,
    });
    expect(repeat.duplicates).toBe(3);
    expect(repeat.blocked).toBe(0);
    expect(await accountBalances()).toEqual(before);
  });

  test('user-modified rows are blocked — local edits stay authoritative', async () => {
    if (!dbReady) return;
    const t1 = await txnRow('up-sync-tx-1');
    await pool.query('UPDATE public.transactions SET memo = $1 WHERE id = $2', ['user note', t1!.id]);
    const result = await syncConnectionTransactions({
      userId,
      connectionId: await connId(),
      aggregator: fakeAggregator([upTx1(), upTx2()]),
    });
    expect(result.blocked).toBe(1);
    const fresh = await txnRow('up-sync-tx-1');
    expect(fresh!.memo).toBe('user note');
    expect(fresh!.amount).toBe(t1!.amount);
    const shadow = await shadowRow(t1!.id);
    expect(shadow!.blocked).toBe(true);
  });

  test('blocked rows are never tombstoned by upstream deletes', async () => {
    if (!dbReady) return;
    const before = await accountBalances();
    const result = await syncConnectionTransactions({
      userId,
      connectionId: await connId(),
      aggregator: fakeAggregator([upTx2()]),
    });
    expect(result.deleted).toBe(0);
    expect(result.blocked).toBe(0);
    expect(await accountBalances()).toEqual(before);
    const t1 = await txnRow('up-sync-tx-1');
    expect(t1!.deleted).toBe(false);
  });

  test('unblocked upstream deletes tombstone the row and reverse the delta', async () => {
    if (!dbReady) return;
    // Revert tx-1 to engine-owned state (undo the user edit from the
    // block test) so the upstream delete applies to it.
    const t1 = await txnRow('up-sync-tx-1');
    await pool.query('UPDATE public.transactions SET memo = NULL WHERE id = $1', [t1!.id]);
    await pool.query('UPDATE public.connection_transactions SET blocked = false WHERE transaction_id = $1', [t1!.id]);
    const before = await accountBalances();

    const result = await syncConnectionTransactions({
      userId,
      connectionId: await connId(),
      aggregator: fakeAggregator([upTx2()]),
    });
    expect(result.deleted).toBe(1);

    const tombstoned = await txnRow('up-sync-tx-1');
    expect(tombstoned!.deleted).toBe(true);
    // Deleted contribution -10000 cents removed from the uncleared bucket.
    const after = await accountBalances();
    expect(after.uncleared_balance).toBe(before.uncleared_balance - (-10000 * 10));
  });

  test('cross-user access surfaces as 404', async () => {
    if (!dbReady) return;
    const conn = { id: await connId() };
    const otherUser = crypto.randomUUID();
    let caught: unknown;
    try {
      await refreshConnection({ userId: otherUser, connectionId: conn.id, aggregator: fakeAggregator([]) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(404);
  });
});

describe.skipIf(!dbReady)('connections sync: transaction scope and sweep completeness', () => {
  const mk = (id: string, cents: number): AggregatedTransaction => ({
    externalId: id,
    externalAccountId: EXTERNAL_ACCOUNT,
    description: `Desc ${id}`,
    amount: cents * 10, // the port carries milliunits
    date: today(),
    currencyCode: 'BRL',
    cleared: false,
  });
  const salary = () => mk('up-sync-tx-2', 100000);
  const pa1 = () => mk('up-scope-1', -1000);
  const pa2 = () => mk('up-scope-2', -2000);

  const sync = async (aggregator: BankAggregator, extra: { upstreamTimeoutMs?: number } = {}) =>
    syncConnectionTransactions({ userId, connectionId: await connId(), aggregator, ...extra });

  /** Cached balances must equal the live ledger (both in milliunits). */
  const expectLedgerConsistent = async () => {
    const sum = await pool.query<{ s: string }>(
      'SELECT COALESCE(SUM(amount), 0)::text AS s FROM public.transactions WHERE account_id = $1 AND NOT deleted',
      [accountId],
    );
    const b = await accountBalances();
    expect(Number(b.cleared_balance) + Number(b.uncleared_balance)).toBe(Number(sum.rows[0]!.s));
  };

  /** True when the connection row can be locked right now (no sync holds it). */
  const rowLockFree = async (): Promise<boolean> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT 1 FROM public.connections WHERE id = $1 FOR UPDATE NOWAIT', [await connId()]);
      await c.query('ROLLBACK');
      return true;
    } catch {
      await c.query('ROLLBACK');
      return false;
    } finally {
      c.release();
    }
  };

  test('upstream is called with no transaction open and no row lock held', async () => {
    const observed: { lockFree: boolean; checkedOut: number }[] = [];
    const aggregator = fakeAggregator([], async () => {
      observed.push({ lockFree: await rowLockFree(), checkedOut: pool.totalCount - pool.idleCount });
      return { transactions: [salary(), pa1(), pa2()], hasMore: false };
    });
    const result = await sync(aggregator);
    expect(result.added).toBe(2);
    expect(observed.length).toBe(1);
    expect(observed[0]!.lockFree).toBe(true);
    // Only the fake's own probe client is out — the sync holds none.
    expect(observed[0]!.checkedOut).toBe(0);
    await expectLedgerConsistent();
  });

  test('a rejected upstream leaves no open transaction, lock, or checked-out client', async () => {
    const before = await accountBalances();
    await expect(
      sync(fakeAggregator([], async () => { throw new Error('bank exploded'); })),
    ).rejects.toThrow('bank exploded');
    expect(await rowLockFree()).toBe(true);
    expect(pool.totalCount - pool.idleCount).toBe(0);
    expect(await accountBalances()).toEqual(before);
  });

  test('a hung upstream times out instead of pinning a client', async () => {
    const before = await accountBalances();
    const hung = fakeAggregator([], () => new Promise(() => {}));
    let caught: unknown;
    try {
      await sync(hung, { upstreamTimeoutMs: 50 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(504);
    expect(await rowLockFree()).toBe(true);
    expect(pool.totalCount - pool.idleCount).toBe(0);
    expect(await accountBalances()).toEqual(before);
  });

  test('a truncated pull (hasMore) tombstones nothing, but still imports what it saw', async () => {
    const before = await accountBalances();
    const result = await sync(
      fakeAggregator([], async () => ({ transactions: [salary()], hasMore: true })),
    );
    expect(result.deleted).toBe(0);
    expect((await txnRow('up-scope-1'))!.deleted).toBe(false);
    expect((await txnRow('up-scope-2'))!.deleted).toBe(false);
    expect(await accountBalances()).toEqual(before);
    await expectLedgerConsistent();
  });

  test('a pull that fails midway tombstones nothing', async () => {
    let calls = 0;
    const flaky = fakeAggregator([], async () => {
      calls += 1;
      throw new Error('page 3 failed');
    });
    const before = await accountBalances();
    await expect(sync(flaky)).rejects.toThrow('page 3 failed');
    expect(calls).toBe(1);
    expect((await txnRow('up-scope-1'))!.deleted).toBe(false);
    expect(await accountBalances()).toEqual(before);
  });

  test('reconciled rows are never tombstoned, even when absent from a complete pull', async () => {
    const row = await txnRow('up-scope-2');
    await pool.query("UPDATE public.transactions SET cleared = 'reconciled' WHERE id = $1", [row!.id]);
    const result = await sync(fakeAggregator([salary(), pa1()]));
    expect(result.deleted).toBe(0);
    expect((await txnRow('up-scope-2'))!.deleted).toBe(false);
    await pool.query("UPDATE public.transactions SET cleared = 'uncleared' WHERE id = $1", [row!.id]);
  });

  test('a complete pull still tombstones a genuinely removed transaction', async () => {
    const result = await sync(fakeAggregator([salary(), pa1()]));
    expect(result.deleted).toBe(1);
    expect((await txnRow('up-scope-2'))!.deleted).toBe(true);
    expect((await txnRow('up-scope-1'))!.deleted).toBe(false);
    await expectLedgerConsistent();
  });

  test('an empty incomplete pull tombstones nothing', async () => {
    const before = await accountBalances();
    const result = await sync(fakeAggregator([], async () => ({ transactions: [], hasMore: true })));
    expect(result.deleted).toBe(0);
    expect(await accountBalances()).toEqual(before);
    await expectLedgerConsistent();
  });

  test('concurrent syncs of one connection do not double-import', async () => {
    const fresh = mk('up-scope-race', -777);
    const agg = () => fakeAggregator([salary(), pa1(), fresh]);
    const [a, b] = await Promise.all([sync(agg()), sync(agg())]);
    expect(a.added + b.added).toBe(1);
    const count = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.transactions WHERE account_id = $1 AND import_id = $2 AND NOT deleted',
      [accountId, `${PROVIDER}:up-scope-race`],
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
    await expectLedgerConsistent();
  });

  test('a sync that committed between our fetch and our write forces a re-snapshot', async () => {
    let calls = 0;
    const racing = fakeAggregator([], async () => {
      calls += 1;
      if (calls === 1) {
        // Simulate another process finishing a sync while we were fetching.
        await pool.query('UPDATE public.connections SET last_synced_at = now() WHERE id = $1', [await connId()]);
      }
      return { transactions: [salary(), pa1(), mk('up-scope-race', -777)], hasMore: false };
    });
    const result = await sync(racing);
    expect(calls).toBe(2);
    expect(result.deleted).toBe(0);
    await expectLedgerConsistent();
  });

  test('an empty but complete pull is a genuinely empty window: unblocked rows are tombstoned', async () => {
    // Designed behaviour: complete + zero rows = upstream has nothing in the
    // window. Incomplete empty pulls (hasMore) are covered by the skip test.
    const result = await sync(fakeAggregator([]));
    expect(result.deleted).toBeGreaterThanOrEqual(2);
    expect((await txnRow('up-scope-1'))!.deleted).toBe(true);
    expect((await txnRow('up-sync-tx-2'))!.deleted).toBe(true);
    await expectLedgerConsistent();
  });
});

describe.skipIf(!dbReady)('connections sync: budget revision', () => {
  test('a sync write bumps the budget revision (clients learn of worker writes)', async () => {
    const rev = async () =>
      Number((await pool.query('SELECT revision FROM public.budgets WHERE id = $1', [budgetId])).rows[0].revision);
    const before = await rev();
    await syncConnectionTransactions({
      userId,
      connectionId: await connId(),
      aggregator: fakeAggregator([
        {
          externalId: 'up-sync-tx-revision',
          externalAccountId: EXTERNAL_ACCOUNT,
          description: 'Revision probe',
          amount: -1000,
          date: today(),
          currencyCode: 'BRL',
          cleared: false,
        },
      ]),
    });
    expect(await rev()).toBeGreaterThan(before);
  });
});
