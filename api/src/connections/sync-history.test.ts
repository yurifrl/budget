/**
 * Pull modes (budget-u5yt), through the real Pluggy adapter over a fake
 * /v2/transactions (newest first, 25 rows a page, `next` continuation):
 *  - full import (first sync of an account) pages to the end of history;
 *  - a capped full import stores a resume point and later syncs finish it,
 *    also when the stored cursor has expired;
 *  - a regular (daily) sync pulls only the last DAILY_SYNC_DAYS days and
 *    never tombstones older rows;
 *  - an account linked later gets a full import while the others stay daily.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { PluggyAggregator } from './adapters/pluggy';
import type { FetchLike } from './adapters/pluggy/client';
import * as store from './store';
import { DAILY_SYNC_DAYS, choosePullMode, dailyPullFrom, syncConnectionTransactions } from './sync';

const PROVIDER = 'testprovider-history';
const userId = crypto.randomUUID();
const budgetId = crypto.randomUUID();
const ROWS = 1_200;
const PAGE = 25;
const ROWS_PER_DAY = 4;
/** Per-test timeout: each full import writes 1,200 rows. */
const SLOW = 120_000;

const dayAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** Fake Pluggy upstream: per account, rows newest first; records every /v2/transactions call. */
class FakePluggy {
  readonly rows = new Map<string, Array<{ id: string; accountId: string; amount: number; date: string; description: string; status: string }>>();
  readonly calls: Array<{ accountId: string; after: string | null }> = [];
  /** Stored cursors the fake refuses once (expired), answered 400 "Invalid cursor". */
  readonly expired = new Set<string>();

  seed(accountId: string, count = ROWS): void {
    this.rows.set(
      accountId,
      Array.from({ length: count }, (_, i) => ({
        id: `${accountId}-tx-${i}`,
        accountId,
        amount: -(i + 1),
        date: dayAgo(Math.floor(i / ROWS_PER_DAY)),
        description: `Shop ${i % 7}`,
        status: 'POSTED',
      })),
    );
  }

  remove(accountId: string, id: string): void {
    this.rows.set(accountId, this.rows.get(accountId)!.filter((r) => r.id !== id));
  }

  callsFor(accountId: string) {
    return this.calls.filter((c) => c.accountId === accountId);
  }

  readonly fetchImpl: FetchLike = async (input) => {
    const url = new URL(input instanceof URL ? input : String(input));
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/auth') return json({ apiKey: 'k', expirationDate: new Date(Date.now() + 3_600_000).toISOString() });
    const account = /^\/accounts\/(.+)$/.exec(url.pathname);
    if (account) return json({ id: account[1], itemId: 'it', type: 'BANK' });
    if (url.pathname === '/v2/transactions') {
      const accountId = url.searchParams.get('accountId')!;
      const after = url.searchParams.get('after');
      this.calls.push({ accountId, after });
      // One-shot: a stored (old) token is refused; the same position reached by a fresh walk is fine.
      if (after != null && this.expired.delete(after)) return json({ message: 'Invalid cursor' }, 400);
      const all = this.rows.get(accountId) ?? [];
      // The cursor names the last row returned, so removed rows never shift pages.
      const start = after == null ? 0 : all.findIndex((r) => r.id === after) + 1;
      const page = all.slice(start, start + PAGE);
      const more = start + PAGE < all.length;
      return json({ results: page, next: more ? `accountId=${accountId}&after=${page.at(-1)!.id}` : null });
    }
    return json({ message: `unexpected ${url.pathname}` }, 404);
  };
}

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE id = $1', [budgetId]);
  await pool.query('DELETE FROM public.connections WHERE provider = $1', [PROVIDER]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
}

let seq = 0;
/** A fresh connection (All history window) with one linked account per external id. */
async function makeConnection(...externalAccountIds: string[]): Promise<{ connectionId: string; accountIds: string[] }> {
  seq += 1;
  const conn = await store.upsertConnection({
    userId,
    provider: PROVIDER,
    externalId: `up-item-history-${seq}-${crypto.randomUUID()}`,
    status: 'connected',
    environment: 'production',
  });
  await pool.query('UPDATE public.connections SET sync_window_days = 0 WHERE id = $1', [conn.id]);
  const accountIds: string[] = [];
  for (const ext of externalAccountIds) accountIds.push(await linkAccount(conn.id, ext));
  return { connectionId: conn.id, accountIds };
}

async function linkAccount(connectionId: string, externalAccountId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO public.accounts (id, budget_id, name, type, account_group, connection_id, external_account_id, currency)
     VALUES ($1, $2, $3, 'checking', 'CASH', $4, $5, 'BRL')`,
    [id, budgetId, `History ${externalAccountId}`, connectionId, externalAccountId],
  );
  return id;
}

const liveRows = async (accountId: string): Promise<number> =>
  Number(
    (await pool.query<{ n: string }>('SELECT count(*) AS n FROM public.transactions WHERE account_id = $1 AND NOT deleted', [accountId]))
      .rows[0]!.n,
  );

const backfillRow = async (accountId: string) =>
  (await pool.query<{ cursor: string | null; before_date: string; rows_pulled: number }>(
    'SELECT cursor, before_date::text AS before_date, rows_pulled FROM public.connection_account_backfill WHERE account_id = $1',
    [accountId],
  )).rows[0];

const historyLoading = async (connectionId: string): Promise<boolean> =>
  (await store.getConnectionByUser(userId, connectionId))!.history_loading;

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, $2, 'sync-history@syscd.local', 'user', 'active')`,
    [userId, userId],
  );
  await pool.query('INSERT INTO public.budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [budgetId, 'sync-history', userId]);
});
afterAll(async () => {
  if (dbReady) await cleanup();
});

describe('pull mode choice', () => {
  test('reimport is full; a resume point resumes; no imported rows is full; else daily', () => {
    expect(choosePullMode({ reimport: true, hasBackfill: true, hasImports: true })).toBe('full');
    expect(choosePullMode({ reimport: false, hasBackfill: true, hasImports: true })).toBe('resume');
    expect(choosePullMode({ reimport: false, hasBackfill: false, hasImports: false })).toBe('full');
    expect(choosePullMode({ reimport: false, hasBackfill: false, hasImports: true })).toBe('daily');
  });

  test('the daily window is the last DAILY_SYNC_DAYS days, never past a shorter sync window', () => {
    expect(dailyPullFrom(0)).toBe(dayAgo(DAILY_SYNC_DAYS));
    expect(dailyPullFrom(365)).toBe(dayAgo(DAILY_SYNC_DAYS));
    expect(dailyPullFrom(7)).toBe(dayAgo(7));
  });
});

describe.skipIf(!dbReady)('sync: full import and daily pulls', () => {
  test('a first sync imports all 1,200 rows over many pages; a re-run adds nothing and pulls only the daily window', async () => {
    const fake = new FakePluggy();
    fake.seed('h-full');
    const aggregator = new PluggyAggregator({ config: cfg(), fetchImpl: fake.fetchImpl });
    const { connectionId, accountIds } = await makeConnection('h-full');

    const first = await syncConnectionTransactions({ userId, connectionId, aggregator });
    expect(first.added).toBe(ROWS);
    expect(fake.callsFor('h-full')).toHaveLength(ROWS / PAGE);
    expect(await liveRows(accountIds[0]!)).toBe(ROWS);
    expect(await backfillRow(accountIds[0]!)).toBeUndefined();
    expect(await historyLoading(connectionId)).toBe(false);

    fake.calls.length = 0;
    const again = await syncConnectionTransactions({ userId, connectionId, aggregator });
    expect(again.added).toBe(0);
    expect(again.deleted).toBe(0);
    // Daily: (DAILY_SYNC_DAYS + 1) days × 4 rows, whole pages, plus the page that dips below.
    expect(again.duplicates).toBeGreaterThanOrEqual((DAILY_SYNC_DAYS + 1) * ROWS_PER_DAY);
    expect(again.duplicates).toBeLessThan(ROWS / 4);
    expect(fake.callsFor('h-full').length).toBeLessThanOrEqual(Math.ceil(((DAILY_SYNC_DAYS + 1) * ROWS_PER_DAY) / PAGE) + 1);
    expect(await liveRows(accountIds[0]!)).toBe(ROWS);
  }, SLOW);

  test('a daily sync tombstones a vanished row inside the last 30 days but never an older one', async () => {
    const fake = new FakePluggy();
    fake.seed('h-daily');
    const aggregator = new PluggyAggregator({ config: cfg(), fetchImpl: fake.fetchImpl });
    const { connectionId, accountIds } = await makeConnection('h-daily');
    expect((await syncConnectionTransactions({ userId, connectionId, aggregator })).added).toBe(ROWS);

    const recent = 'h-daily-tx-20'; // 5 days ago
    const old = `h-daily-tx-${100 * ROWS_PER_DAY}`; // 100 days ago
    fake.remove('h-daily', recent);
    fake.remove('h-daily', old);
    fake.calls.length = 0;

    const daily = await syncConnectionTransactions({ userId, connectionId, aggregator });
    expect(daily.deleted).toBe(1);
    const state = await pool.query<{ external_transaction_id: string; deleted: boolean }>(
      `SELECT s.external_transaction_id, t.deleted FROM public.connection_transactions s
       JOIN public.transactions t ON t.id = s.transaction_id
       WHERE t.account_id = $1 AND s.external_transaction_id = ANY($2)`,
      [accountIds[0], [recent, old]],
    );
    const deleted = Object.fromEntries(state.rows.map((r) => [r.external_transaction_id, r.deleted]));
    expect(deleted[recent]).toBe(true);
    expect(deleted[old]).toBe(false);
    // The daily pull stopped at the window: far fewer than the 48 pages of history.
    expect(fake.callsFor('h-daily').length).toBeLessThanOrEqual(6);
  }, SLOW);

  test('a capped full import resumes on later syncs until done, then syncs go daily', async () => {
    const fake = new FakePluggy();
    fake.seed('h-cap');
    const aggregator = new PluggyAggregator({ config: cfg(), fetchImpl: fake.fetchImpl });
    const { connectionId, accountIds } = await makeConnection('h-cap');
    const acc = accountIds[0]!;
    const cap = 500;

    const first = await syncConnectionTransactions({ userId, connectionId, aggregator, fullImportMaxRows: cap });
    expect(first.added).toBe(500);
    expect(first.deleted).toBe(0);
    const point = await backfillRow(acc);
    expect(point?.cursor).toBe('after=h-cap-tx-499');
    expect(point?.before_date).toBe(dayAgo(Math.floor(499 / ROWS_PER_DAY)));
    expect(point?.rows_pulled).toBe(500);
    expect(await historyLoading(connectionId)).toBe(true);

    fake.calls.length = 0;
    const second = await syncConnectionTransactions({ userId, connectionId, aggregator, fullImportMaxRows: cap });
    expect(second.added).toBe(500);
    expect(second.deleted).toBe(0);
    // The history pull continued from the stored cursor.
    expect(fake.callsFor('h-cap').some((c) => c.after === 'h-cap-tx-499')).toBe(true);
    expect((await backfillRow(acc))?.rows_pulled).toBe(1_000);
    expect(await historyLoading(connectionId)).toBe(true);

    const third = await syncConnectionTransactions({ userId, connectionId, aggregator, fullImportMaxRows: cap });
    expect(third.added).toBe(200);
    expect(await backfillRow(acc)).toBeUndefined();
    expect(await historyLoading(connectionId)).toBe(false);
    expect(await liveRows(acc)).toBe(ROWS);

    fake.calls.length = 0;
    const fourth = await syncConnectionTransactions({ userId, connectionId, aggregator, fullImportMaxRows: cap });
    expect(fourth.added).toBe(0);
    expect(fourth.deleted).toBe(0);
    expect(fake.callsFor('h-cap').length).toBeLessThanOrEqual(6); // daily again
  }, SLOW);

  test('an expired resume cursor walks again from the newest page and still finishes', async () => {
    const fake = new FakePluggy();
    fake.seed('h-exp');
    const aggregator = new PluggyAggregator({ config: cfg(), fetchImpl: fake.fetchImpl });
    const { connectionId, accountIds } = await makeConnection('h-exp');
    const acc = accountIds[0]!;

    expect((await syncConnectionTransactions({ userId, connectionId, aggregator, fullImportMaxRows: 500 })).added).toBe(500);
    fake.expired.add('h-exp-tx-499');
    const resumed = await syncConnectionTransactions({ userId, connectionId, aggregator, fullImportMaxRows: 1_000 });
    // Only rows on or before the stored date count toward the cap, so the rest of history arrives.
    expect(resumed.added).toBe(700);
    expect(resumed.deleted).toBe(0);
    expect(await backfillRow(acc)).toBeUndefined();
    expect(await liveRows(acc)).toBe(ROWS);
  }, SLOW);

  test('Re-import history restarts a full pull and adds nothing already imported', async () => {
    const fake = new FakePluggy();
    fake.seed('h-re');
    const aggregator = new PluggyAggregator({ config: cfg(), fetchImpl: fake.fetchImpl });
    const { connectionId } = await makeConnection('h-re');
    expect((await syncConnectionTransactions({ userId, connectionId, aggregator })).added).toBe(ROWS);
    fake.calls.length = 0;
    const re = await syncConnectionTransactions({ userId, connectionId, aggregator, ignoreWatermark: true });
    expect(re.added).toBe(0);
    expect(re.duplicates).toBe(ROWS);
    expect(fake.callsFor('h-re')).toHaveLength(ROWS / PAGE);
  }, SLOW);

  test('an account linked later gets a full import while the imported one stays daily', async () => {
    const fake = new FakePluggy();
    fake.seed('h-old');
    fake.seed('h-new');
    const aggregator = new PluggyAggregator({ config: cfg(), fetchImpl: fake.fetchImpl });
    const { connectionId, accountIds } = await makeConnection('h-old');
    expect((await syncConnectionTransactions({ userId, connectionId, aggregator })).added).toBe(ROWS);

    const newAcc = await linkAccount(connectionId, 'h-new');
    fake.calls.length = 0;
    const result = await syncConnectionTransactions({ userId, connectionId, aggregator });
    expect(result.added).toBe(ROWS);
    expect(await liveRows(newAcc)).toBe(ROWS);
    expect(await liveRows(accountIds[0]!)).toBe(ROWS);
    expect(fake.callsFor('h-new')).toHaveLength(ROWS / PAGE);
    expect(fake.callsFor('h-old').length).toBeLessThanOrEqual(6);
  }, SLOW);
});

function cfg() {
  return { pluggyClientId: 'cid', pluggyClientSecret: 'secret', pluggyBaseUrl: 'https://api.pluggy.ai', sandbox: false, itemIds: [], clientUserId: 'u' };
}
