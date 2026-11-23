/**
 * Liveness of a long sync (Temporal heartbeatTimeout 30s): onProgress fires
 * per upstream row in phase 2, not only per account, and the activity's
 * timer heartbeat is always cleared, on success and on error.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { withHeartbeat } from './activities';
import * as store from './store';
import { syncConnectionTransactions } from './sync';
import type { AggregatedTransaction, BankAggregator } from './types';

const PROVIDER = 'testprovider-heartbeat';
const userId = crypto.randomUUID();
const budgetId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const EXT_ACC = 'up-acc-heartbeat';
const ROWS = 25;
const today = () => new Date().toISOString().slice(0, 10);

const txn = (i: number): AggregatedTransaction => ({
  externalId: `hb-tx-${i}`,
  externalAccountId: EXT_ACC,
  description: `Heartbeat probe ${i}`,
  amount: -1_000 * (i + 1),
  date: today(),
  currencyCode: null,
  cleared: true,
  raw: { id: `hb-tx-${i}` },
});
const aggregator = {
  environment: 'production',
  listExternalAccounts: async () => [],
  listTransactions: async () => ({ transactions: Array.from({ length: ROWS }, (_, i) => txn(i)), hasMore: false }),
} as unknown as BankAggregator;

let connectionId = '';

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE id = $1', [budgetId]);
  await pool.query('DELETE FROM public.connections WHERE provider = $1', [PROVIDER]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, $2, 'sync-heartbeat@syscd.local', 'user', 'active')`,
    [userId, userId],
  );
  await pool.query('INSERT INTO public.budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [budgetId, 'sync-heartbeat', userId]);
  const conn = await store.upsertConnection({
    userId,
    provider: PROVIDER,
    externalId: 'up-item-heartbeat-1',
    clientUserId: `cu-${userId}`,
    status: 'connected',
    environment: 'production',
  });
  connectionId = conn.id;
  await pool.query(
    `INSERT INTO public.accounts (id, budget_id, name, type, account_group, connection_id, external_account_id, currency)
     VALUES ($1, $2, 'Hb', 'checking', 'CASH', $3, $4, 'BRL')`,
    [accountId, budgetId, connectionId, EXT_ACC],
  );
});
afterAll(async () => {
  if (dbReady) await cleanup();
});

describe.skipIf(!dbReady)('sync: per-row progress', () => {
  test('onProgress fires at least once per upstream row (fresh and repeat pulls)', async () => {
    let calls = 0;
    const first = await syncConnectionTransactions({ userId, connectionId, aggregator, ignoreWatermark: true, onProgress: () => (calls += 1) });
    expect(first.added).toBe(ROWS);
    expect(calls).toBeGreaterThanOrEqual(ROWS);

    calls = 0;
    const second = await syncConnectionTransactions({ userId, connectionId, aggregator, ignoreWatermark: true, onProgress: () => (calls += 1) });
    expect(second.duplicates).toBe(ROWS);
    expect(calls).toBeGreaterThanOrEqual(ROWS);
  });
});

describe('withHeartbeat timer', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('beats while running and stops after success', async () => {
    let beats = 0;
    const out = await withHeartbeat(async () => {
      await wait(40);
      return 'ok';
    }, () => (beats += 1), 5);
    expect(out).toBe('ok');
    expect(beats).toBeGreaterThan(0);
    const after = beats;
    await wait(30);
    expect(beats).toBe(after);
  });

  test('stops after an error and rethrows it', async () => {
    let beats = 0;
    await expect(
      withHeartbeat(async () => {
        await wait(40);
        throw new Error('boom');
      }, () => (beats += 1), 5),
    ).rejects.toThrow('boom');
    expect(beats).toBeGreaterThan(0);
    const after = beats;
    await wait(30);
    expect(beats).toBe(after);
  });
});
