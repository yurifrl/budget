/**
 * G1: bank sync stores the provider's currency on a linked account, only
 * while the account has none. A user-set value is never overwritten, a
 * provider that fails to list accounts never blocks the import, and once
 * every linked account has a currency the sync stops asking.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import * as store from './store';
import { syncConnectionTransactions } from './sync';
import type { AggregatedTransaction, BankAggregator, ExternalAccount } from './types';

const PROVIDER = 'testprovider-currency';
const userId = crypto.randomUUID();
const budgetId = crypto.randomUUID();
const usdAccount = crypto.randomUUID();
const eurAccount = crypto.randomUUID();
const EXT_USD = 'up-acc-currency-usd';
const EXT_EUR = 'up-acc-currency-eur';
const EXTERNAL_ITEM = 'up-item-currency-1';
const today = () => new Date().toISOString().slice(0, 10);

let listCalls = 0;
let listImpl: () => Promise<ExternalAccount[]> = async () => [];
const external = (externalId: string, currencyCode: string | null): ExternalAccount => ({
  externalId,
  name: externalId,
  type: 'BANK',
  currencyCode,
  balance: 0,
  institution: null,
});
const txn = (externalAccountId: string): AggregatedTransaction => ({
  externalId: `${externalAccountId}-tx`,
  externalAccountId,
  description: 'Currency probe',
  amount: -10_000,
  date: today(),
  currencyCode: null,
  cleared: false,
});
const aggregator = {
  environment: 'production',
  listExternalAccounts: async () => {
    listCalls += 1;
    return listImpl();
  },
  listTransactions: async (externalAccountId: string) => ({ transactions: [txn(externalAccountId)], hasMore: false }),
} as unknown as BankAggregator;

let connectionId = '';
const sync = () => syncConnectionTransactions({ userId, connectionId, aggregator, ignoreWatermark: true });
const currencyOf = async (id: string) =>
  (await pool.query<{ currency: string | null }>('SELECT currency FROM accounts WHERE id = $1', [id])).rows[0]!.currency;

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE id = $1', [budgetId]);
  await pool.query('DELETE FROM public.connections WHERE provider = $1', [PROVIDER]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, $2, 'sync-currency@syscd.local', 'user', 'active')`,
    [userId, userId],
  );
  await pool.query('INSERT INTO public.budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [budgetId, 'sync-currency', userId]);
  const conn = await store.upsertConnection({
    userId,
    provider: PROVIDER,
    externalId: EXTERNAL_ITEM,
    clientUserId: `cu-${userId}`,
    status: 'connected',
    environment: 'production',
  });
  connectionId = conn.id;
  // usd: no currency yet (NULL = the budget's); eur: the user already chose EUR.
  await pool.query(
    `INSERT INTO public.accounts (id, budget_id, name, type, account_group, connection_id, external_account_id, currency)
     VALUES ($1, $3, 'Usd', 'checking', 'CASH', $4, $5, NULL), ($2, $3, 'Eur', 'checking', 'CASH', $4, $6, 'EUR')`,
    [usdAccount, eurAccount, budgetId, connectionId, EXT_USD, EXT_EUR],
  );
});
afterAll(async () => {
  if (dbReady) await cleanup();
});

describe.skipIf(!dbReady)('sync: provider currency on linked accounts', () => {
  test('a provider failure leaves currency NULL and still imports', async () => {
    listImpl = async () => {
      throw new Error('provider down');
    };
    const result = await sync();
    expect(result.added).toBe(2);
    expect(await currencyOf(usdAccount)).toBeNull();
    expect(await currencyOf(eurAccount)).toBe('EUR');
  });

  test('NULL adopts the provider code (normalised); a user-set value is kept', async () => {
    listImpl = async () => [external(EXT_USD, 'usd'), external(EXT_EUR, 'BRL')];
    await sync();
    expect(await currencyOf(usdAccount)).toBe('USD');
    expect(await currencyOf(eurAccount)).toBe('EUR');
  });

  test('once every linked account has a currency the sync stops listing accounts', async () => {
    const before = listCalls;
    await sync();
    expect(listCalls).toBe(before);
  });

  test('an invalid provider code is ignored', async () => {
    await pool.query('UPDATE accounts SET currency = NULL WHERE id = $1', [usdAccount]);
    listImpl = async () => [external(EXT_USD, 'dollars')];
    await sync();
    expect(await currencyOf(usdAccount)).toBeNull();
  });
});
