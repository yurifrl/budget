/**
 * Characterisation tests for the sync engine's payee write path (written
 * before sync's private PayeeResolver was replaced by budget's ledger API).
 * They pin what sync did:
 * - a renaming rule that matches the upstream description ASSIGNS its payee
 *   (budget-mkrt: it used to splice the payee's name into the matching part of
 *   the text); the transaction keeps the bank's text in import_payee_name(_original)
 *   and the shadow payload carries the payee's name;
 * - the assigned payee is used as it is (a name with surrounding spaces is NOT
 *   trimmed), unlike budget's own upsertPayee, which trims;
 * - a blank description stores no payee and NULL import names;
 * - an upstream description change refreshes payee_id and the import names
 *   through the same rules, keeping cleared/approved.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import * as store from './store';
import { syncConnectionTransactions } from './sync';
import type { AggregatedTransaction, BankAggregator } from './types';

const PROVIDER = 'testprovider-payees';
const userId = crypto.randomUUID();
const budgetId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const EXTERNAL_ACCOUNT = 'up-acc-payees-1';
const EXTERNAL_ITEM = 'up-item-payees-1';
const today = () => new Date().toISOString().slice(0, 10);

let upstream: AggregatedTransaction[] = [];
const aggregator = {
  environment: 'production',
  createConnectToken: async () => ({ token: 't', clientId: 'c', widgetUrl: 'https://widget.example' }),
  listExternalAccounts: async () => [],
  fetchInstitution: async () => null,
  getItemState: async () => ({ status: 'connected' as const, lastUpdatedAt: null }),
  listTransactions: async () => ({ transactions: upstream.map((t) => ({ ...t })), hasMore: false }),
  deleteConnection: async () => {},
  mapWebhookDelivery: () => null,
  mapStatus: () => 'connected' as const,
  verifyWebhookHeaders: () => false,
} as unknown as BankAggregator;

const up = (externalId: string, description: string, amount = -10000): AggregatedTransaction => ({
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

const row = async (externalId: string) =>
  (
    await pool.query<{
      payee_id: string | null;
      payee_name: string | null;
      import_payee_name: string | null;
      import_payee_name_original: string | null;
      cleared: string;
      approved: boolean;
      payload: { payee: string };
    }>(
      `SELECT t.payee_id, p.name AS payee_name, t.import_payee_name, t.import_payee_name_original,
              t.cleared, t.approved, s.last_synced_payload AS payload
         FROM transactions t
         JOIN connection_transactions s ON s.transaction_id = t.id
         LEFT JOIN payees p ON p.id = t.payee_id
        WHERE t.account_id = $1 AND t.import_id = $2 AND NOT t.deleted`,
      [accountId, `${PROVIDER}:${externalId}`],
    )
  ).rows[0]!;

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE id = $1', [budgetId]);
  await pool.query('DELETE FROM public.connections WHERE provider = $1', [PROVIDER]);
  await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, $2, 'sync-payees@syscd.local', 'user', 'active')`,
    [userId, userId],
  );
  await pool.query('INSERT INTO public.budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [budgetId, 'sync-payees', userId]);
  await pool.query(
    `INSERT INTO public.accounts (id, budget_id, name, type, account_group) VALUES ($1, $2, 'Checking', 'checking', 'CASH')`,
    [accountId, budgetId],
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
  await pool.query('UPDATE public.accounts SET connection_id = $1, external_account_id = $2 WHERE id = $3', [
    connectionId,
    EXTERNAL_ACCOUNT,
    accountId,
  ]);
  // Rules: "contains UBER" -> payee "Uber"; "is PADDED RAW" -> payee " Padded " (surrounding spaces kept).
  await pool.query(`INSERT INTO payees (budget_id, name) VALUES ($1, 'Uber'), ($1, ' Padded ')`, [budgetId]);
  await pool.query(
    `INSERT INTO payee_renaming_rules (budget_id, payee_id, match_type, condition)
     SELECT $1, id, CASE name WHEN 'Uber' THEN 'contains' ELSE 'is' END, CASE name WHEN 'Uber' THEN 'UBER' ELSE 'PADDED RAW' END
       FROM payees WHERE budget_id = $1`,
    [budgetId],
  );
});

afterAll(async () => {
  if (dbReady) await cleanup();
});

describe.skipIf(!dbReady)('sync payee write path (characterisation)', () => {
  test('a matching rule assigns its payee (name kept verbatim) and the bank text stays the import name; blank stays null', async () => {
    upstream = [up('p1', 'UBER *TRIP 123'), up('p2', 'PADDED RAW'), up('p3', '   '), up('p4', '  Bakery  ')];
    const result = await sync();
    expect(result.added).toBe(4);

    // A contains-rule assigns its payee itself: the rest of the text is not kept in the name.
    const p1 = await row('p1');
    expect(p1.payee_name).toBe('Uber');
    expect(p1.import_payee_name).toBe('UBER *TRIP 123');
    expect(p1.import_payee_name_original).toBe('UBER *TRIP 123');
    expect(p1.payload.payee).toBe('Uber');

    const p2 = await row('p2');
    expect(p2.payee_name).toBe(' Padded ');
    expect(p2.import_payee_name).toBe('PADDED RAW');
    expect(p2.payload.payee).toBe(' Padded ');
    const trimmed = await pool.query("SELECT 1 FROM payees WHERE budget_id = $1 AND name = 'Padded'", [budgetId]);
    expect(trimmed.rowCount).toBe(0);

    const p3 = await row('p3');
    expect(p3.payee_id).toBeNull();
    expect(p3.import_payee_name).toBeNull();
    expect(p3.payload.payee).toBe('');

    // No rule: the trimmed description is the payee.
    const p4 = await row('p4');
    expect(p4.payee_name).toBe('Bakery');
    expect(p4.import_payee_name).toBe('Bakery');
    expect(p4).toMatchObject({ cleared: 'uncleared', approved: false });
  });

  test('an upstream description change refreshes payee and import names through the rules', async () => {
    await pool.query("UPDATE transactions SET approved = true WHERE import_id = $1", [`${PROVIDER}:p4`]);
    upstream = [up('p1', 'UBER *TRIP 123'), up('p2', 'PADDED RAW'), up('p3', '   '), up('p4', 'UBER EATS')];
    const result = await sync();
    expect(result.updated).toBe(1);
    expect(result.duplicates).toBe(3);
    const p4 = await row('p4');
    expect(p4.payee_name).toBe('Uber');
    expect(p4.import_payee_name).toBe('UBER EATS');
    expect(p4.import_payee_name_original).toBe('UBER EATS');
    expect(p4.payload.payee).toBe('Uber');
    expect(p4).toMatchObject({ cleared: 'uncleared', approved: true });
  });
});
