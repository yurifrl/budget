/**
 * Contract outputs (G9), catalog-level: every ai, budget, connections and
 * features operation declares an `output` schema, and every READ operation,
 * called over HTTP on seeded data, answers 200 with a body that parses with it.
 * Lists are seeded so each one validates real rows, never just `[]`.
 *
 * (Writes are covered too: the bun test preload turns on output validation
 * in `mountOperations`, so every handler result exercised by any test is
 * checked against its contract.)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts } from './catalog';
import { pool } from './core/db';
import { dbReady } from './core/test-gate';
import { makeOpCaller } from './core/test-op';
import { httpOnError } from './core/validate';
import budget from './budget';
import categorize from './categorize/router';
import ai from './ai';
import connections from './connections';
import { featuresRoutes } from './features';
import { setAggregators } from './connections/registry';
import { setProviders, type ProviderEntry } from './ai/providers';
import type { AiProviderId } from '@shared/contracts/ai';
import { configureSecretBox } from './core/secret-box';
import * as connStore from './connections/store';
import { syncConnectionTransactions } from './connections/sync';
import type { AggregatedTransaction, BankAggregator, ExternalAccount } from './connections/types';
import { authConfig, configureAuth, type IdentityUser } from './user';

const covered = contracts.filter(
  (c) => c.name.startsWith('ai_') || c.name.startsWith('budget_') || c.name.startsWith('connections_') || c.name.startsWith('features_'),
);
const reads = covered.filter((c) => c.kind === 'read' && c.expose.api);

const user: IdentityUser = {
  id: crypto.randomUUID(),
  email: 'catalog-outputs@catalogoutputs.test',
  googleSub: null,
  // admin: the features admin list is one of the reads below.
  role: 'admin',
  status: 'active',
};
const B = crypto.randomUUID();
const EXT_ITEM = 'up-item-catalog-outputs';
const EXT_ACC = 'up-acc-catalog-outputs';
const today = new Date().toISOString().slice(0, 10);

const upstreamAccount: ExternalAccount = {
  externalId: EXT_ACC,
  name: 'Catalog Card',
  type: 'CREDIT',
  currencyCode: 'BRL',
  balance: -125_000,
  institution: 'Catalog Bank',
  credit: {
    limit: 5_000_000,
    available: 4_875_000,
    used: 125_000,
    minimumPayment: 10_000,
    dueDate: '2026-12-05',
    latestBill: { total: 125_000, dueDate: '2026-12-05', minimumPayment: 10_000 },
  },
};
const imported: AggregatedTransaction = {
  externalId: 'catalog-outputs-tx-1',
  externalAccountId: EXT_ACC,
  description: 'Catalog Coffee',
  amount: -12_340,
  cleared: true,
  date: today,
  currencyCode: null,
  raw: { id: 'catalog-outputs-tx-1' },
};
const aggregator = {
  environment: 'production',
  verifyCredentials: async () => true,
  hasItem: async () => true,
  createConnectToken: async () => ({ token: 't', clientId: null, widgetUrl: null }),
  listExternalAccounts: async () => [upstreamAccount],
  fetchInstitution: async () => 'Catalog Bank',
  getItemState: async () => ({ status: 'connected' as const, lastUpdatedAt: null }),
  listTransactions: async () => ({ transactions: [{ ...imported }], hasMore: false }),
  deleteConnection: async () => {},
  mapWebhookDelivery: () => null,
  mapStatus: () => 'connected' as const,
  verifyWebhookHeaders: () => false,
} as unknown as BankAggregator;

/** Fake AI providers: the key routes only need listModels; no provider is called. */
const aiModels = [{ id: 'catalog-model', name: 'Catalog Model', contextLength: 128_000 }];
const fakeAiEntry = (id: AiProviderId): ProviderEntry => ({
  baseUrl: `https://${id}.test`,
  create: () => ({
    id,
    chat: async () => {
      throw new Error('chat is not used by the catalog outputs test');
    },
    verifyKey: async () => null,
    listModels: async () => aiModels,
  }),
});
const aiProviders: Record<AiProviderId, ProviderEntry> = {
  openrouter: fakeAiEntry('openrouter'),
  anthropic: fakeAiEntry('anthropic'),
  openai: fakeAiEntry('openai'),
  zai: fakeAiEntry('zai'),
  deepseek: fakeAiEntry('deepseek'),
};

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/connections', connections);
app.route('/ai', ai);
app.route('/', budget);
app.route('/categorize', categorize);
app.route('/', featuresRoutes());
const op = makeOpCaller(app, contracts);

/** Ids captured while seeding, used to build each read's sample input. */
const seeded = { account: '', card: '', category: '', payee: '', connection: '', importedTxn: '' };

async function ok(name: string, input: Record<string, unknown>) {
  const res = await op(name, input);
  if (res.status >= 300) throw new Error(`seed ${name} failed: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

let authBefore: ReturnType<typeof authConfig> | null = null;

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE owner_user_id = $1', [user.id]);
  await pool.query(`DELETE FROM public.feature_overrides WHERE feature_key = 'shared-pluggy-key'`);
  await pool.query('DELETE FROM public.connections WHERE user_id = $1', [user.id]);
  await pool.query(`DELETE FROM public.users WHERE email LIKE '%@catalogoutputs.test'`);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  setAggregators({ pluggy: { create: () => aggregator, configured: () => true } });
  setProviders(aiProviders);
  // The harness sets the user with no session principal: the first-party guard of /admin/features passes only with auth off.
  authBefore = authConfig();
  configureAuth({ ...authBefore, authDisabled: true });
  await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, 'admin')`, [user.id, user.email]);
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'catalog-outputs', $2)`, [B, user.id]);
  await pool.query(`INSERT INTO budget_members (budget_id, user_id) VALUES ($1, $2)`, [B, user.id]);

  const group = await ok('budget_groups_create', { budget_id: B, name: 'Bills' });
  const c1 = await ok('budget_categories_create', { budget_id: B, group_id: group.id, name: 'Rent', sort_order: 0 });
  const c2 = await ok('budget_categories_create', { budget_id: B, group_id: group.id, name: 'Power', sort_order: 1 });
  seeded.category = c1.id;
  await ok('budget_bundles_create', { budget_id: B, group_id: group.id, name: 'Home', category_ids: [c1.id, c2.id] });
  await ok('budget_categories_set_target', { id: c1.id, budget_id: B, target: { amount: 1_500_000, cadence: 'monthly' } });
  await ok('budget_category_targets_set', { categoryId: c2.id, budget_id: B, kind: 'monthly', amount: 250_000, snooze_month: null });

  const account = await ok('budget_accounts_create', { budget_id: B, name: 'Checking', type: 'checking', balance: 10_000_000, currency: 'BRL' });
  const card = await ok('budget_accounts_create', { budget_id: B, name: 'Catalog Card', type: 'creditCard' });
  seeded.account = account.id;
  seeded.card = card.id;

  const txn = (over: Record<string, unknown>) => ({
    account_id: account.id,
    date: today,
    payee: 'Landlord',
    category_id: null,
    memo: null,
    outflow: 0,
    inflow: 0,
    cleared: 'uncleared',
    approved: true,
    flag: null,
    repeat: 'never',
    ...over,
  });
  const rent = await ok('budget_transactions_create', { budget_id: B, txn: txn({ category_id: c1.id, outflow: 1_500_000, flag: 'red' }) });
  await ok('budget_transactions_create', {
    budget_id: B,
    txn: txn({ payee: 'Utility', outflow: 300_000 }),
    subtransactions: [
      { category_id: c1.id, memo: 'a', outflow: 100_000, inflow: 0 },
      { category_id: c2.id, memo: 'b', outflow: 200_000, inflow: 0 },
    ],
  });
  await ok('budget_transactions_create', { budget_id: B, txn: txn({ payee: 'Transfer : Catalog Card', outflow: 50_000 }) });
  // An uncategorized checking outflow and an equal card inflow: a transfer suggestion (hand-entered, so never auto-linked).
  await ok('budget_transactions_create', { budget_id: B, txn: txn({ payee: 'Pix enviado', outflow: 77_000 }) });
  await ok('budget_transactions_create', { budget_id: B, txn: txn({ account_id: card.id, payee: 'Pagamento recebido', inflow: 77_000 }) });
  seeded.payee = rent.payee_id;
  await ok('budget_payees_set_rename_rule', { id: rent.payee_id, budget_id: B, match_type: 'contains', condition: 'landlord co' });
  await ok('budget_assignments_set', { budget_id: B, month: `${today.slice(0, 7)}-01`, category_id: c1.id, budgeted: 1_500_000 });
  await ok('budget_month_notes_set', { budget_id: B, month: `${today.slice(0, 7)}-01`, note: 'month' });
  await ok('budget_category_notes_set', { categoryId: c1.id, budget_id: B, month: `${today.slice(0, 7)}-01`, note: 'cat' });
  await ok('budget_repeat_rules_create', {
    budget_id: B,
    account_id: account.id,
    payee: 'Landlord',
    category_id: c1.id,
    memo: null,
    outflow: 1_500_000,
    inflow: 0,
    frequency: 'monthly',
    next_due_date: '2099-01-01',
  });
  await ok('budget_members_add', { budget_id: B, name: 'Placeholder Person' });

  // A bank connection linked to the card, with one imported (synced) row.
  const conn = await connStore.upsertConnection({
    userId: user.id,
    provider: 'pluggy',
    externalId: EXT_ITEM,
    clientUserId: user.id,
    status: 'connected',
    environment: 'production',
  });
  seeded.connection = conn.id;
  await ok('budget_accounts_update', { id: card.id, budget_id: B, link: { connectionId: conn.id, externalAccountId: EXT_ACC } });
  await syncConnectionTransactions({ userId: user.id, connectionId: conn.id, aggregator, ignoreWatermark: true });
  const importedRow = await pool.query<{ id: string }>(
    `SELECT t.id FROM transactions t JOIN connection_transactions ct ON ct.transaction_id = t.id WHERE t.account_id = $1`,
    [card.id],
  );
  seeded.importedTxn = importedRow.rows[0]!.id;

  // Features: a value for everyone and one user override, so the admin list validates real rows.
  // The user's own value is ON: the connection above runs on the shared keys and must stay usable
  // (off would pause it, and connections_upstream_list would answer accounts: null).
  await ok('features_admin_set_everyone', { key: 'shared-pluggy-key', value: false });
  await ok('features_admin_set_user', { key: 'shared-pluggy-key', user_id: user.id, value: true });

  // The user's own key set, saved through the operation (checked with the fake provider, stored encrypted).
  configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
  await ok('connections_credentials_save', { clientId: 'catalog-client-id', clientSecret: 'catalog-client-secret' });
  await ok('ai_credentials_save', { api_key: 'sk-or-v1-catalogoutputs0123456789', model: 'catalog-model' });
});

afterAll(async () => {
  if (!dbReady) return;
  setAggregators(null);
  setProviders(null);
  configureSecretBox(null);
  await cleanup();
  if (authBefore) configureAuth(authBefore);
});

/** Sample input for every read; a new read operation fails the coverage test until it has one. */
function sampleInput(name: string): Record<string, unknown> | undefined {
  const month = `${today.slice(0, 7)}-01`;
  const samples: Record<string, Record<string, unknown>> = {
    ai_credentials_get: {},
    ai_credentials_test: {},
    ai_models_list: {},
    budget_list: {},
    budget_revision_get: { budget_id: B },
    budget_groups_list: { budget_id: B },
    budget_categories_list: { budget_id: B },
    budget_bundles_list: { budget_id: B },
    budget_accounts_list: { budget_id: B },
    budget_transactions_list: { budget_id: B },
    categorize_queue_list: { budget_id: B, limit: 10 },
    categorize_run_status: { budget_id: B },
    categorize_settings_get: { budget_id: B },
    // The bank-imported row, so the import record (raw payload included) is validated too.
    budget_transactions_get: { id: seeded.importedTxn, budget_id: B },
    budget_assignments_list: { budget_id: B },
    budget_month_notes_list: { budget_id: B },
    budget_payees_list: { budget_id: B },
    budget_payees_transactions: { id: seeded.payee, budget_id: B },
    budget_payee_suggestions_get: { id: seeded.payee, budget_id: B },
    budget_payees_transfer_rule_get: { id: seeded.payee, budget_id: B },
    budget_transfer_suggestions_list: { budget_id: B },
    budget_category_targets_list: { budget_id: B },
    budget_category_notes_list: { budget_id: B, month },
    budget_members_list: { budget_id: B },
    budget_repeat_rules_list: { budget_id: B },
    budget_export: { budget_id: B },
    connections_list: {},
    connections_credentials_get: {},
    connections_settings_get: {},
    connections_upstream_list: {},
    connections_get: { id: seeded.connection },
    connections_sync_status: {},
    connections_accounts_summary: { id: seeded.connection },
    connections_transactions_list: { id: seeded.connection, accountId: seeded.card },
    features_mine: {},
    features_admin_list: {},
  };
  return samples[name];
}

describe('contract outputs: coverage', () => {
  test('every budget, connections and features operation declares an output schema', () => {
    const missing = covered.filter((c) => !c.output).map((c) => c.name);
    expect(missing).toEqual([]);
    expect(covered.length).toBeGreaterThan(80);
  });

  test('every read has a sample input here', () => {
    expect(reads.filter((c) => sampleInput(c.name) === undefined).map((c) => c.name)).toEqual([]);
  });
});

describe.skipIf(!dbReady)('contract outputs: every read parses with its output schema on seeded data', () => {
  for (const contract of reads) {
    test(contract.name, async () => {
      const res = await op(contract.name, sampleInput(contract.name)!);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const parsed = contract.output!.safeParse(res.json);
      expect(parsed.success ? 'ok' : parsed.error.issues).toBe('ok');
      // A seeded list must not be empty, so its row schema met real rows.
      const rows = Array.isArray(res.json) ? res.json : (res.json?.rows ?? res.json?.items ?? res.json?.members ?? res.json?.accounts);
      if (Array.isArray(rows)) expect(rows.length, `${contract.name} returned no rows`).toBeGreaterThan(0);
    });
  }
});
