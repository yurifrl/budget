/**
 * budgetApi wire contract — endpoints are generated from the server operation
 * contracts (contractRequest). These tests drive the REAL budgetApi slice
 * through a store whose thunk extra is a test-Container and capture the HTTP
 * request via a stubbed globalThis.fetch, asserting method / url / parsed body
 * exactly as the server would receive them.
 */

import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, test } from 'bun:test';

import { Container } from '@/platform/di/container';
import { Tokens } from '@/platform/di/tokens';
import type { KVStore } from '@/platform/storage/types';

import { budgetApi, CATEGORIZE_COUNT_LIMIT, CATEGORIZE_QUEUE_TAGS, queueProvidedTags } from './api';

const BASE = 'http://api.test:3999';

function makeStore() {
  const container = new Container()
    .registerValue(Tokens.Config, { apiUrl: BASE, connectionsProvider: 'test-provider' })
    .registerValue(Tokens.Storage, {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    } as unknown as KVStore);
  return configureStore({
    reducer: { [budgetApi.reducerPath]: budgetApi.reducer },
    middleware: (gdm) =>
      gdm({ thunk: { extraArgument: container } }).concat(budgetApi.middleware),
  });
}

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let captured: Captured | null = null;

/** Repo convention (core/api/baseQuery.test.ts): swap globalThis.fetch, restore in finally. */
function stubFetchCapture(reply: unknown = undefined): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (url: string | URL, init?: RequestInit) => {
    captured = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    return reply === undefined ? new Response(null, { status: 204 }) : Response.json(reply);
  }, originalFetch);
  return () => {
    globalThis.fetch = originalFetch;
  };
}


async function run(thunk: (s: ReturnType<typeof makeStore>) => unknown, reply?: unknown): Promise<Captured> {
  const restore = stubFetchCapture(reply);
  try {
    const store = makeStore();
    await (store.dispatch as (a: unknown) => { unwrap(): Promise<unknown> })(thunk(store)).unwrap();
    return captured!;
  } finally {
    restore();
  }
}

const txn = {
  accountId: 'acc-1', date: '2026-11-17', payee: 'Cafe', categoryId: null, memo: '',
  outflowCents: 500, inflowCents: 0, cleared: 'uncleared' as const, approved: true, flag: null, repeat: 'never',
};

describe('transaction writes carry no client-computed deltas', () => {
  test('addTransaction: POST /transactions, no deltas key', async () => {
    const c = await run(() => budgetApi.endpoints.addTransaction.initiate({ budgetId: 'b-1', txn }));
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${BASE}/transactions`);
    expect(Object.keys(c.body!).sort()).toEqual(['budget_id', 'txn']);
  });

  test('updateTransaction: PATCH /transactions/:id, bulk-clear patch has no deltas', async () => {
    const c = await run(() =>
      budgetApi.endpoints.updateTransaction.initiate({ budgetId: 'b-1', id: 't-9', patch: { cleared: 'cleared' } }),
    );
    expect(c.method).toBe('PATCH');
    expect(c.url).toBe(`${BASE}/transactions/t-9`);
    expect(c.body).toEqual({ budget_id: 'b-1', patch: { cleared: 'cleared' } });
  });

  test('deleteTransaction: DELETE with budget_id in the query and no body', async () => {
    const c = await run(() => budgetApi.endpoints.deleteTransaction.initiate({ budgetId: 'b-1', id: 't-9' }));
    expect(c.method).toBe('DELETE');
    expect(c.url).toBe(`${BASE}/transactions/t-9?budget_id=b-1`);
    expect(c.body).toBeNull();
  });
});

describe('contract-derived requests', () => {
  test('setCategoryTarget: PUT /category-targets/:id?budget_id with a milliunit body', async () => {
    const c = await run(() =>
      budgetApi.endpoints.setCategoryTarget.initiate({
        budgetId: 'b-1', categoryId: 'cat-x',
        target: { kind: 'monthly', amountCents: 1000, config: {} },
      }),
    );
    expect(c.method).toBe('PUT');
    expect(c.url).toBe(`${BASE}/category-targets/cat-x?budget_id=b-1`);
    expect(c.body).toEqual({ kind: 'monthly', amount: 10000, snooze_month: null, config: {} });
  });

  test('setAssigned: milliunits on the wire', async () => {
    const c = await run(() =>
      budgetApi.endpoints.setAssigned.initiate({ budgetId: 'b-1', month: 202611, categoryId: 'cat-x', assignedCents: 1234 }),
    );
    expect(c.url).toBe(`${BASE}/assignments`);
    expect(c.body).toEqual({ budget_id: 'b-1', month: '2026-11-01', category_id: 'cat-x', budgeted: 12340 });
  });

  test('removeBudgetMember: DELETE with both keys in the query', async () => {
    const c = await run(() => budgetApi.endpoints.removeBudgetMember.initiate({ budgetId: 'b-1', userId: 'u-1' }));
    expect(c.method).toBe('DELETE');
    expect(c.url).toBe(`${BASE}/budget-members?budget_id=b-1&user_id=u-1`);
  });

  test('getPayeeTransactions: GET with limit/offset defaults in the query', async () => {
    const c = await run(() => budgetApi.endpoints.getPayeeTransactions.initiate({ budgetId: 'b-1', payeeId: 'p-1' }));
    expect(c.url).toBe(`${BASE}/payees/p-1/transactions?budget_id=b-1&limit=50&offset=0`);
  });

  test('getTransactionDetails: GET /transactions/:id with budget_id in the query', async () => {
    const c = await run(() => budgetApi.endpoints.getTransactionDetails.initiate({ budgetId: 'b-1', id: 't-1' }));
    expect(c.method).toBe('GET');
    expect(c.url).toBe(`${BASE}/transactions/t-1?budget_id=b-1`);
  });

  test('getConnectionTransactions: first page has no cursor; limit 50 in the query', async () => {
    const c = await run(() =>
      budgetApi.endpoints.getConnectionTransactions.initiate({ id: 'c-1', accountId: 'a-1' }),
    );
    expect(c.method).toBe('GET');
    expect(c.url).toBe(`${BASE}/connections/c-1/transactions?accountId=a-1&limit=50`);
  });

  test('getConnectionSummary: GET /connections/:id/summary', async () => {
    const c = await run(() => budgetApi.endpoints.getConnectionSummary.initiate({ id: 'c-1' }));
    expect(c.url).toBe(`${BASE}/connections/c-1/summary`);
  });

  test('linkAccount: PATCH /accounts/:id with link object (unlink = null connectionId)', async () => {
    const c = await run(() =>
      budgetApi.endpoints.linkAccount.initiate({ budgetId: 'b-1', accountId: 'a-1', connectionId: null }),
    );
    expect(c.url).toBe(`${BASE}/accounts/a-1`);
    expect(c.body).toEqual({ budget_id: 'b-1', link: { connectionId: null, externalAccountId: null } });
  });

  test('restoreBudget: budget_id in the query, payload as a format-2 (milliunit) body', async () => {
    const payload = {
      groups: [],
      categories: [],
      transactions: [{ accountIndex: 0, outflow: 1234, inflow: 0 }],
      assignments: [{ categoryIndex: 0, month: '2026-01-01', budgeted: -500 }],
    };
    const c = await run(() => budgetApi.endpoints.restoreBudget.initiate({ budgetId: 'b-1', payload }));
    expect(c.url).toBe(`${BASE}/budgets/restore?budget_id=b-1`);
    expect(c.body).toEqual({
      groups: [],
      categories: [],
      format_version: 2,
      transactions: [{ accountIndex: 0, outflow: 12340, inflow: 0 }],
      assignments: [{ categoryIndex: 0, month: '2026-01-01', budgeted: -5000 }],
    });
  });
});

describe('category person writes', () => {
  test('setCategoryPerson: PATCH /categories/:id/person with budget_id in the query', async () => {
    const c = await run(() =>
      budgetApi.endpoints.setCategoryPerson.initiate({ budgetId: 'b-1', categoryId: 'c-9', userId: 'u-1' }),
    );
    expect(c.method).toBe('PATCH');
    expect(c.url).toBe(`${BASE}/categories/c-9/person?budget_id=b-1`);
    expect(c.body).toEqual({ user_id: 'u-1' });
  });

  test('setGroupPerson: PATCH /categories/group-person, null clears to Shared', async () => {
    const c = await run(() =>
      budgetApi.endpoints.setGroupPerson.initiate({ budgetId: 'b-1', groupId: 'g-2', userId: null }),
    );
    expect(c.method).toBe('PATCH');
    expect(c.url).toBe(`${BASE}/categories/group-person?budget_id=b-1`);
    expect(c.body).toEqual({ group_id: 'g-2', user_id: null });
  });
});

describe('bundle endpoints', () => {
  test('createBundle: POST /bundles', async () => {
    const c = await run(() =>
      budgetApi.endpoints.createBundle.initiate({ budgetId: 'b-1', groupId: 'g-1', name: 'Meds', categoryIds: ['c-1', 'c-2'] }),
    );
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${BASE}/bundles`);
    expect(c.body).toEqual({ budget_id: 'b-1', group_id: 'g-1', name: 'Meds', category_ids: ['c-1', 'c-2'] });
  });

  test('setCategoriesBundle: PATCH /bundles/categories', async () => {
    const c = await run(() =>
      budgetApi.endpoints.setCategoriesBundle.initiate({ budgetId: 'b-1', categoryIds: ['c-1'], bundleId: null }),
    );
    expect(c.method).toBe('PATCH');
    expect(c.url).toBe(`${BASE}/bundles/categories?budget_id=b-1`);
    expect(c.body).toEqual({ category_ids: ['c-1'], bundle_id: null });
  });

  test('renameBundle and deleteBundle address /bundles/:id', async () => {
    const r = await run(() => budgetApi.endpoints.renameBundle.initiate({ budgetId: 'b-1', bundleId: 'x-1', name: 'N' }));
    expect(r.url).toBe(`${BASE}/bundles/x-1/name?budget_id=b-1`);
    const d = await run(() => budgetApi.endpoints.deleteBundle.initiate({ budgetId: 'b-1', bundleId: 'x-1' }));
    expect(d.method).toBe('DELETE');
    expect(d.url).toBe(`${BASE}/bundles/x-1?budget_id=b-1`);
  });
});

describe('formerly hand-written URLs now come from contracts (same routes)', () => {
  const cases: [string, (s: ReturnType<typeof makeStore>) => unknown, string, string, Record<string, unknown> | null][] = [
    ['getUsdBrlRate', () => budgetApi.endpoints.getUsdBrlRate.initiate(), 'GET', '/rates/usd-brl', null],
    ['getMe', () => budgetApi.endpoints.getMe.initiate(), 'GET', '/auth/me', null],
    ['getConnections', () => budgetApi.endpoints.getConnections.initiate(), 'GET', '/connections', null],
    ['getConnection', () => budgetApi.endpoints.getConnection.initiate({ id: 'c-1' }), 'GET', '/connections/c-1', null],
    [
      'createConnectionToken',
      () => budgetApi.endpoints.createConnectionToken.initiate({ provider: 'pluggy', itemId: 'it-1' }),
      'POST',
      '/connections/connect-token',
      { provider: 'pluggy', itemId: 'it-1' },
    ],
    [
      'registerConnection',
      () => budgetApi.endpoints.registerConnection.initiate({ provider: 'pluggy', itemId: 'it-1' }),
      'POST',
      '/connections/items',
      { provider: 'pluggy', itemId: 'it-1' },
    ],
    ['syncConnection', () => budgetApi.endpoints.syncConnection.initiate({ id: 'c-1', budgetId: 'b-1' }), 'POST', '/connections/c-1/sync', null],
    ['reimportHistory', () => budgetApi.endpoints.reimportHistory.initiate({ id: 'c-1', budgetId: 'b-1' }), 'POST', '/connections/c-1/reimport', null],
    ['disconnectConnection', () => budgetApi.endpoints.disconnectConnection.initiate({ id: 'c-1', budgetId: 'b-1' }), 'DELETE', '/connections/c-1', null],
    ['getUpstreamAccounts', () => budgetApi.endpoints.getUpstreamAccounts.initiate(), 'GET', '/connections/upstream', null],
    ['getConnectionSettings', () => budgetApi.endpoints.getConnectionSettings.initiate(), 'GET', '/connections/settings', null],
    [
      'getConnectionCredentials',
      () => budgetApi.endpoints.getConnectionCredentials.initiate({ provider: 'pluggy' }),
      'GET',
      '/connections/credentials?provider=pluggy',
      null,
    ],
    [
      'saveConnectionCredentials',
      () => budgetApi.endpoints.saveConnectionCredentials.initiate({ provider: 'pluggy', clientId: 'id-1', clientSecret: 's-1' }),
      'PUT',
      '/connections/credentials',
      { provider: 'pluggy', clientId: 'id-1', clientSecret: 's-1' },
    ],
    [
      'deleteConnectionCredentials',
      () => budgetApi.endpoints.deleteConnectionCredentials.initiate({ provider: 'pluggy' }),
      'DELETE',
      '/connections/credentials?provider=pluggy',
      null,
    ],
    ['updateSyncWindow', () => budgetApi.endpoints.updateSyncWindow.initiate({ syncWindowDays: 90 }), 'PATCH', '/connections/settings', { syncWindowDays: 90 }],
    [
      'updateConnectionSyncWindow',
      () => budgetApi.endpoints.updateConnectionSyncWindow.initiate({ id: 'c-1', syncWindowDays: null }),
      'PATCH',
      '/connections/c-1/settings',
      { syncWindowDays: null },
    ],
    ['getAiCredentials', () => budgetApi.endpoints.getAiCredentials.initiate(), 'GET', '/ai/credentials', null],
    [
      'saveAiCredentials',
      () => budgetApi.endpoints.saveAiCredentials.initiate({ apiKey: 'sk-or-secret-1', provider: 'openrouter', model: 'openai/gpt-4o-mini' }),
      'PUT',
      '/ai/credentials',
      { api_key: 'sk-or-secret-1', provider: 'openrouter', model: 'openai/gpt-4o-mini' },
    ],
    [
      // The model is optional (a key the provider forbids listing models with can still be saved).
      'saveAiCredentialsWithoutModel',
      () => budgetApi.endpoints.saveAiCredentials.initiate({ apiKey: 'sk-or-secret-1', provider: 'openrouter' }),
      'PUT',
      '/ai/credentials',
      { api_key: 'sk-or-secret-1', provider: 'openrouter' },
    ],
    ['deleteAiCredentials', () => budgetApi.endpoints.deleteAiCredentials.initiate(), 'DELETE', '/ai/credentials', null],
    ['testAiCredentials', () => budgetApi.endpoints.testAiCredentials.initiate(), 'GET', '/ai/credentials/test', null],
    [
      'detectAiProvider',
      () => budgetApi.endpoints.detectAiProvider.initiate({ apiKey: 'sk-ant-secret-1' }),
      'POST',
      '/ai/provider-detect',
      { api_key: 'sk-ant-secret-1' },
    ],
    [
      'listAiModels',
      () => budgetApi.endpoints.listAiModels.initiate({ apiKey: 'sk-or-secret-1', provider: 'openrouter' }),
      'POST',
      '/ai/models',
      { api_key: 'sk-or-secret-1', provider: 'openrouter' },
    ],
  ];
  // Endpoints with a transformResponse need a body to transform.
  const replies: Record<string, unknown> = { registerConnection: { connection: {}, accounts: [] }, getUpstreamAccounts: [] };
  for (const [name, thunk, method, path, body] of cases) {
    test(`${name}: ${method} ${path}`, async () => {
      const c = await run(thunk, replies[name]);
      expect(c.method).toBe(method);
      expect(c.url).toBe(`${BASE}${path}`);
      expect(c.body).toEqual(body);
    });
  }
});

describe('the split slice is still one api', () => {
  test('the Categorize queue follows transaction, category and payee writes', () => {
    const types: readonly string[] = CATEGORIZE_QUEUE_TAGS;
    for (const type of ['Categorize', 'Transactions', 'Categories', 'Payees']) {
      expect(types).toContain(type);
    }
  });

  test("the rail badge's one-row read follows only the Categorize tag; the page's reads follow every write", () => {
    expect(queueProvidedTags('b1', { limit: CATEGORIZE_COUNT_LIMIT })).toEqual([{ type: 'Categorize', id: 'b1' }]);
    expect(queueProvidedTags('b1', { limit: 200 }).map((t) => t.type)).toEqual([...CATEGORIZE_QUEUE_TAGS]);
    // A bundle's rows with limit 1 are not the badge.
    expect(queueProvidedTags('b1', { limit: 1, bundle: 'k' }).length).toBe(CATEGORIZE_QUEUE_TAGS.length);
    expect(queueProvidedTags('b1', {}).length).toBe(CATEGORIZE_QUEUE_TAGS.length);
  });

  test('one reducer path, the same tag types, every endpoint reachable from budgetApi', () => {
    expect(budgetApi.reducerPath).toBe('budgetApi');
    const endpoints = Object.keys(budgetApi.endpoints);
    expect(endpoints).toHaveLength(106);
    for (const name of ['getBudgets', 'getCategories', 'getPayees', 'getTransactions', 'getConnections', 'getBudgetMembers', 'restoreBudget', 'getTransferSuggestions', 'setPayeeTransferRule', 'getCategorizeQueue', 'acceptCategorize', 'undoCategorize', 'skipCategorize', 'startCategorizeRun', 'getCategorizeRunStatus', 'getCategorizeSettings', 'setCategorizeSettings']) {
      expect(endpoints).toContain(name);
    }
  });
});
