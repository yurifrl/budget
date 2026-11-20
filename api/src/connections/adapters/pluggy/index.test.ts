import { describe, expect, it } from 'bun:test';

import {
  PluggyAggregator,
  classifyPluggyError,
  hasQuotaWarning,
  itemStateFrom,
  mapItemStatus,
  toAggregatedTransaction,
  toCreditDetails,
  toExternalAccount,
  webhookSecretFrom,
} from './index';
import { AggregatorError } from '../../errors';
import { PluggyConfigError, PluggyError, configurePluggyEnv, retryAfterMsFrom, type FetchLike } from './client';
import { Bill, type Transaction } from './types';

const cfg = {
  pluggyClientId: 'cid',
  pluggyClientSecret: 'secret',
  pluggyBaseUrl: 'https://api.pluggy.ai',
  sandbox: false,
  itemIds: [],
  clientUserId: 'user-1',
};

type MockResult = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
type RecordedCall = { url: URL; init: RequestInit };

/** Test seam: records every fetch call, answers from `routes`. */
function makeFetch(routes: (url: URL, init: RequestInit) => MockResult | Promise<MockResult>) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input instanceof URL ? input : String(input));
    calls.push({ url, init: init ?? {} });
    const r = await routes(url, init ?? {});
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : r.text ?? '', {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  };
  return { calls, fetchImpl };
}

const callsTo = (calls: RecordedCall[], path: string) => calls.filter((c) => c.url.pathname === path);

/** Aggregator over a fixed config, injectable fetch and clock. */
function makeAggregator(fetchImpl: FetchLike) {
  return new PluggyAggregator({ config: cfg, fetchImpl, now: () => 1_000_000 });
}

const authJson = (): MockResult => ({ json: { apiKey: 'key-1', expirationDate: new Date(61_000_000).toISOString() } });

describe('adapter: account mapping', () => {
  it('reshapes an upstream account onto ExternalAccount', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/accounts') {
        return {
          json: {
            results: [
              {
                id: 'ac1',
                itemId: 'it1',
                type: 'BANK',
                name: ' Checking ',
                balance: -12.345,
                currencyCode: 'BRL',
                institution: 'Nubank',
              },
              { id: 'ac2', itemId: 'it1', type: 'CREDIT', balance: null, currencyCode: null },
            ],
          },
        };
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const accounts = await makeAggregator(fetchImpl).listExternalAccounts('it1');
    expect(accounts).toEqual([
      {
        externalId: 'ac1',
        name: 'Checking',
        type: 'BANK',
        currencyCode: 'BRL',
        balance: -12340, // float → whole cents via Math.round (rounds half up), then milliunits
        institution: 'Nubank',
      },
      {
        externalId: 'ac2',
        name: '',
        type: 'CREDIT',
        currencyCode: null,
        balance: null,
        institution: null,
        credit: {
          limit: null,
          available: null,
          used: null,
          minimumPayment: null,
          dueDate: null,
          latestBill: null, // /bills unavailable → degrade, never hide the account
        },
      },
    ]);
  });

  it('maps a non-string institution field to null', () => {
    const mapped = toExternalAccount({ id: 'ac1', itemId: 'it1', type: 'BANK', institution: { id: 7 } } as never);
    expect(mapped.institution).toBeNull();
  });
});

describe('adapter: transaction mapping', () => {
  it('reshapes upstream transactions onto AggregatedTransaction', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/accounts/ac1') return { json: { id: 'ac1', itemId: 'it1', type: 'BANK' } };
      if (url.pathname === '/v2/transactions') {
        return {
          json: {
            results: [
              { id: 'tx1', accountId: 'ac1', amount: -12.5, date: '2026-01-05', description: ' coffee ', status: 'POSTED' },
              { id: 'tx2', accountId: 'ac1', amount: 3, date: '2026-01-06', description: '', status: 'PENDING' },
              { id: 'tx3', accountId: 'ac1', amount: 0.005, date: '2026-01-07', status: null },
            ],
            nextPage: null,
          },
        };
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const pull = await makeAggregator(fetchImpl).listTransactions('ac1', { from: '2026-01-01', to: '2026-01-31' });
    expect(pull.hasMore).toBe(false);
    expect(pull.transactions).toEqual([
      {
        externalId: 'tx1',
        externalAccountId: 'ac1',
        description: 'coffee',
        amount: -12500,
        cleared: true,
        date: '2026-01-05',
        currencyCode: null,
      },
      {
        externalId: 'tx2',
        externalAccountId: 'ac1',
        description: '',
        amount: 3000,
        cleared: false,
        date: '2026-01-06',
        currencyCode: null,
      },
      {
        externalId: 'tx3',
        externalAccountId: 'ac1',
        description: '',
        amount: 10, // rounds half away from zero
        cleared: false,
        date: '2026-01-07',
        currencyCode: null,
      },
    ]);
  });

  it('sends only accountId + cursor to /v2/transactions — bounds are applied client-side', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/accounts/ac1') return { json: { id: 'ac1', itemId: 'it1', type: 'BANK' } };
      if (url.pathname === '/v2/transactions') return { json: { results: [], nextPage: null } };
      throw new Error(`unexpected ${url.pathname}`);
    });
    await makeAggregator(fetchImpl).listTransactions('ac1', { from: '2026-02-01', to: '2026-02-28' });
    const tx = callsTo(calls, '/v2/transactions')[0];
    expect(tx.url.searchParams.get('accountId')).toBe('ac1');
    expect(tx.url.searchParams.get('from')).toBeNull();
    expect(tx.url.searchParams.get('to')).toBeNull();
    expect(tx.url.searchParams.get('pageSize')).toBeNull();
  });

  it('maps POSTED and BALANCED as cleared, everything else uncleared', () => {
    const txn = (status?: string | null): Transaction => ({
      id: 'tx',
      accountId: 'ac1',
      amount: 1,
      date: '2026-01-05',
      ...(status !== undefined ? { status } : {}),
    });
    expect(toAggregatedTransaction(txn('POSTED')).cleared).toBe(true);
    expect(toAggregatedTransaction(txn('BALANCED')).cleared).toBe(true);
    expect(toAggregatedTransaction(txn('pending')).cleared).toBe(false);
    expect(toAggregatedTransaction(txn()).cleared).toBe(false);
  });
});

describe('adapter: connect token', () => {
  it('returns token, clientId and widgetUrl from the upstream response', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/connect_token') {
        return { json: { accessToken: 'tok-1', connectUrl: 'https://connect.pluggy.ai/?token=tok-1' } };
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const token = await makeAggregator(fetchImpl).createConnectToken({ clientUserId: 'u-9' });
    expect(token).toEqual({
      token: 'tok-1',
      clientId: 'cid',
      widgetUrl: 'https://connect.pluggy.ai/?token=tok-1',
    });
    const body = JSON.parse(String(callsTo(calls, '/connect_token')[0].init.body));
    expect(body.clientUserId).toBe('u-9');
  });

  it('constructs the widgetUrl when production omits connectUrl (live-traffic regression)', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/connect_token') return { json: { accessToken: 'tok-p' } };
      throw new Error(`unexpected ${url.pathname}`);
    });
    const token = await makeAggregator(fetchImpl).createConnectToken({ clientUserId: 'u-9' });
    expect(token).toEqual({
      token: 'tok-p',
      clientId: 'cid',
      widgetUrl: 'https://connect.pluggy.ai/?connect_token=tok-p',
    });
  });

  it('scopes the token to an existing item for re-auth', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/connect_token') {
        return { json: { accessToken: 'tok-2', connectUrl: 'https://connect.pluggy.ai/?token=tok-2' } };
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    await makeAggregator(fetchImpl).createConnectToken({ clientUserId: 'user-1', itemId: 'it1' });
    const body = JSON.parse(String(callsTo(calls, '/connect_token')[0].init.body));
    expect(body.itemId).toBe('it1');
    expect(body.sandbox).toBe(false);
  });
});

describe('adapter: deleteConnection', () => {
  it('deletes upstream and swallows an already-gone 404', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/items/it1') return { status: 204 };
      if (url.pathname === '/items/it-gone') return { status: 404, json: { message: 'not found' } };
      throw new Error(`unexpected ${url.pathname}`);
    });
    const agg = makeAggregator(fetchImpl);
    await agg.deleteConnection('it1');
    await agg.deleteConnection('it-gone'); // idempotent — no throw
    expect(callsTo(calls, '/items/it1')).toHaveLength(1);
    const gone = callsTo(calls, '/items/it-gone')[0];
    expect(gone.init.method).toBe('DELETE');
  });

  it('propagates upstream errors other than 404', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/items/it1') return { status: 500, text: 'boom' };
      throw new Error(`unexpected ${url.pathname}`);
    });
    expect(makeAggregator(fetchImpl).deleteConnection('it1')).rejects.toThrow();
  });
});

describe('adapter: webhook delivery mapping', () => {
  const agg = new PluggyAggregator({ config: cfg });

  it('classifies a recognizable event payload into a Delivery', () => {
    const raw = { event: 'item_updated', eventId: 'ev1', itemId: 'it1', clientUserId: 'user-1', extra: true };
    expect(agg.mapWebhookDelivery(raw)).toEqual({
      event: 'item_updated',
      eventId: 'ev1',
      externalItemId: 'it1',
      clientUserId: 'user-1',
      action: 'ignore',
      raw,
    });
  });

  it('tolerates a missing item and user identity', () => {
    expect(agg.mapWebhookDelivery({ event: 'item_created', eventId: 'ev2' })).toEqual({
      event: 'item_created',
      eventId: 'ev2',
      externalItemId: null,
      clientUserId: null,
      action: 'ignore',
      raw: { event: 'item_created', eventId: 'ev2' },
    });
  });

  it('rejects unrecognizable payloads with null', () => {
    expect(agg.mapWebhookDelivery(null)).toBeNull();
    expect(agg.mapWebhookDelivery('nope')).toBeNull();
    expect(agg.mapWebhookDelivery({ event: 'x' })).toBeNull(); // missing eventId
    expect(agg.mapWebhookDelivery({ eventId: 'e1' })).toBeNull(); // missing event
    expect(agg.mapWebhookDelivery({ event: '', eventId: 'e1' })).toBeNull();
  });
});

describe('adapter: status mapping', () => {
  it('maps the upstream status table onto the connection lifecycle', () => {
    expect(mapItemStatus('UPDATED')).toBe('connected');
    expect(mapItemStatus('UPDATING')).toBe('connected');
    expect(mapItemStatus('ACCOUNT_UPDATED')).toBe('connected');
    expect(mapItemStatus('PROCESSING')).toBe('connected');
    expect(mapItemStatus('LOGIN_ERROR')).toBe('unauthorized');
    expect(mapItemStatus('WAITING_USER_ACTION')).toBe('unauthorized');
    expect(mapItemStatus('MFA_CHALLENGE')).toBe('unauthorized');
    expect(mapItemStatus('OUTDATED')).toBe('error');
    expect(mapItemStatus('SOMETHING_NEW')).toBe('error');
  });

  it('exposes the same table through the port method', () => {
    const agg = new PluggyAggregator({ config: cfg });
    expect(agg.mapStatus('MFA_CHALLENGE')).toBe('unauthorized');
  });
});

describe('adapter: webhook header verification', () => {
  const headers = (init?: Record<string, string>): Headers => new Headers(init);

  it('accepts the secret via Bearer or custom header', () => {
    const agg = new PluggyAggregator({ config: cfg, webhookSecret: 's3cret' });
    expect(agg.verifyWebhookHeaders(headers({ authorization: 'Bearer s3cret' }))).toBe(true);
    expect(agg.verifyWebhookHeaders(headers({ 'x-pluggy-webhook-secret': ' s3cret ' }))).toBe(true);
    expect(agg.verifyWebhookHeaders(headers({ authorization: 'Bearer wrong' }))).toBe(false);
    expect(agg.verifyWebhookHeaders(headers({ 'x-pluggy-webhook-secret': 'wrong' }))).toBe(false);
    expect(agg.verifyWebhookHeaders(headers())).toBe(false);
  });

  it('fails closed when unconfigured', () => {
    const agg = new PluggyAggregator({ config: cfg, webhookSecret: '' });
    expect(agg.verifyWebhookHeaders(headers({ authorization: 'Bearer s3cret' }))).toBe(false);
    expect(agg.verifyWebhookHeaders(headers())).toBe(false);
  });

  it('defaults to the PLUGGY_WEBHOOK_SECRET env key', () => {
    configurePluggyEnv({ PLUGGY_WEBHOOK_SECRET: 'from-env' });
    try {
      const agg = new PluggyAggregator({ config: cfg });
      expect(agg.verifyWebhookHeaders(headers({ 'x-pluggy-webhook-secret': 'from-env' }))).toBe(true);
      expect(agg.verifyWebhookHeaders(headers({ 'x-pluggy-webhook-secret': 'other' }))).toBe(false);
    } finally {
      configurePluggyEnv({});
    }
  });

  it('webhookSecretFrom reports which header authenticated', () => {
    expect(webhookSecretFrom(headers({ authorization: 'Bearer k' }), 'k')).toBe('authorization');
    expect(webhookSecretFrom(headers({ 'x-pluggy-webhook-secret': 'k' }), 'k')).toBe('x-pluggy-webhook-secret');
    expect(webhookSecretFrom(headers(), 'k')).toBeNull();
  });
});

describe('adapter: institution lookup', () => {
  const itemResponse = (item: Record<string, unknown>): MockResult => ({
    json: { status: 'UPDATED', ...item },
  });

  it('prefers the item connector name and falls back to the institution object', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      // Current API shape: the connector is a nested object, no flat fields.
      if (url.pathname === '/items/it1') {
        return itemResponse({
          id: 'it1',
          connector: { id: 200, name: 'Itaú Unibanco PF' },
        });
      }
      if (url.pathname === '/items/it2') {
        return itemResponse({ id: 'it2', connectorName: 'Legacy Name Co' });
      }
      if (url.pathname === '/items/it3') {
        return itemResponse({ id: 'it3', institution: { id: 7, name: 'Banco Itaú' } });
      }
      if (url.pathname === '/items/it4') {
        return itemResponse({ id: 'it4', connector: { id: 9, name: '   ' }, connectorName: '  ' });
      }
      if (url.pathname === '/items/it5') {
        return itemResponse({ id: 'it5', connector: { id: 200, name: 'MeuPluggy' } });
      }
      if (url.pathname === '/accounts') {
        const itemId = url.searchParams.get('itemId');
        // Only the wrapper item has accounts to fall back to.
        return itemId === 'it5'
          ? {
              json: {
                results: [
                  { id: 'ac5b', itemId: 'it5', type: 'CREDIT', name: 'ultraviolet-black', balance: null, currencyCode: null },
                  { id: 'ac5a', itemId: 'it5', type: 'BANK', name: 'Nu Pagamentos S.A. - Instituição de Pagamento', balance: 10, currencyCode: 'BRL' },
                ],
              },
            }
          : { json: { results: [] } };
      }
      return { status: 404 };
    });
    const agg = makeAggregator(fetchImpl);
    expect(await agg.fetchInstitution('it1')).toBe('Itaú Unibanco PF');
    expect(await agg.fetchInstitution('it2')).toBe('Legacy Name Co');
    expect(await agg.fetchInstitution('it3')).toBe('Banco Itaú');
    expect(await agg.fetchInstitution('it4')).toBeNull();
    // Open-Finance wrapper: the item says only "MeuPluggy", so the bank comes
    // from the bank account's name, legal suffix stripped.
    expect(await agg.fetchInstitution('it5')).toBe('Nu Pagamentos S.A.');
    // An unknown item is an upstream error, not "no name" — callers catch it.
    expect(agg.fetchInstitution('it-none')).rejects.toThrow('404');
  });
});


describe('adapter: credit accounts', () => {
  const rows = [
    { id: 'p1', accountId: 'cc1', amount: 125.83, date: '2026-01-05', description: 'purchase', status: 'POSTED' },
    { id: 'p2', accountId: 'cc1', amount: -1538.44, date: '2026-01-06', description: 'bill payment', status: 'POSTED' },
  ];

  it('inverts signs for CREDIT accounts: purchases negative, payments positive', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/accounts/cc1') return { json: { id: 'cc1', itemId: 'it1', type: 'CREDIT' } };
      if (url.pathname === '/v2/transactions') return { json: { results: rows, nextPage: null } };
      throw new Error(`unexpected ${url.pathname}`);
    });
    const agg = makeAggregator(fetchImpl);
    const pull = await agg.listTransactions('cc1');
    expect(pull.transactions.map((t) => t.amount)).toEqual([-125830, 1538440]);
    // account type is cached: a second pull does not refetch the account
    await agg.listTransactions('cc1');
    expect(callsTo(calls, '/accounts/cc1')).toHaveLength(1);
  });

  it('leaves BANK account signs unchanged', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/accounts/cc1') return { json: { id: 'cc1', itemId: 'it1', type: 'BANK' } };
      if (url.pathname === '/v2/transactions') return { json: { results: rows, nextPage: null } };
      throw new Error(`unexpected ${url.pathname}`);
    });
    const pull = await makeAggregator(fetchImpl).listTransactions('cc1');
    expect(pull.transactions.map((t) => t.amount)).toEqual([125830, -1538440]);
  });

  it('uses the account type learned from a listing without an extra fetch', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/accounts') return { json: { results: [{ id: 'cc1', itemId: 'it1', type: 'CREDIT', balance: 0 }] } };
      if (url.pathname === '/bills') return { json: { results: [] } };
      if (url.pathname === '/v2/transactions') return { json: { results: rows, nextPage: null } };
      throw new Error(`unexpected ${url.pathname}`);
    });
    const agg = makeAggregator(fetchImpl);
    await agg.listExternalAccounts('it1');
    const pull = await agg.listTransactions('cc1');
    expect(pull.transactions[0]?.amount).toBe(-125830);
    expect(callsTo(calls, '/accounts/cc1')).toHaveLength(0);
  });

  it('parses bills that carry no accountId', () => {
    const bill = Bill.parse({
      id: 'b1',
      dueDate: '2026-11-05T00:00:00.000Z',
      billClosingDate: '2026-10-28',
      totalAmount: 17123.34,
      totalAmountCurrencyCode: 'BRL',
      minimumPaymentAmount: 2673.38,
      allowsInstallments: true,
      financeCharges: [],
      payments: [],
      createdAt: '2026-11-01',
      updatedAt: '2026-11-01',
    });
    expect(bill.totalAmount).toBe(17123.34);
    expect(bill.accountId).toBeUndefined();
  });

  it('maps credit details: total-limit line wins over unreliable top-level figures; latest bill by due date', () => {
    const credit = toCreditDetails(
      {
        creditLimit: 15000,
        availableCreditLimit: 15000,
        minimumPayment: 2673.38,
        balanceDueDate: '2026-11-05',
        disaggregatedCreditLimits: [
          { creditLineLimitType: 'LIMITE_CREDITO_TOTAL', limitAmount: 84260, usedAmount: 40437.82, availableAmount: 43822.18 },
          { creditLineLimitType: 'OUTRO', limitAmount: 1000, usedAmount: 999 },
        ],
      },
      [
        Bill.parse({ id: 'old', dueDate: '2026-10-05', totalAmount: 9000, minimumPaymentAmount: 900 }),
        Bill.parse({ id: 'new', dueDate: '2026-11-05', totalAmount: 17123.34, minimumPaymentAmount: 2673.38 }),
      ],
    );
    expect(credit).toEqual({
      limit: 84_260_000,
      available: 43_822_180,
      used: 40_437_820,
      minimumPayment: 2_673_380,
      dueDate: '2026-11-05',
      latestBill: { total: 17_123_340, dueDate: '2026-11-05', minimumPayment: 2_673_380 },
    });
  });

  it('falls back to limit - available, and tolerates garbage creditData', () => {
    expect(toCreditDetails({ creditLimit: 1000, availableCreditLimit: 400 }).used).toBe(600_000);
    const none = toCreditDetails('nonsense');
    expect(none.used).toBeNull();
    expect(none.latestBill).toBeNull();
    expect(toExternalAccount({ id: 'b', itemId: 'i', type: 'BANK' } as never).credit).toBeUndefined();
  });
});

describe('adapter: item status mapping (table)', () => {
  const cases: Array<[string, string]> = [
    ['UPDATED', 'connected'],
    ['UPDATING', 'connected'],
    ['ACCOUNT_UPDATED', 'connected'],
    ['PROCESSING', 'connected'],
    ['PARTIAL_SUCCESS', 'connected'],
    ['LOGIN_ERROR', 'unauthorized'],
    ['WAITING_USER_ACTION', 'unauthorized'],
    ['MFA_CHALLENGE', 'unauthorized'],
    ['OUTDATED', 'error'],
    ['SOMETHING_NEW', 'error'],
  ];
  for (const [provider, expected] of cases) {
    it(`${provider} → ${expected}`, () => expect(mapItemStatus(provider)).toBe(expected as ReturnType<typeof mapItemStatus>));
  }

  it('PARTIAL_SUCCESS with a 423 warning anywhere in statusDetail → quota_exhausted', () => {
    const detail = { transactions: { isUpdated: false, warnings: [{ code: '423', message: 'quota' }] } };
    expect(hasQuotaWarning(detail)).toBe(true);
    expect(hasQuotaWarning({ a: [{ code: 423 }] })).toBe(true);
    expect(hasQuotaWarning({ a: [{ code: '401' }] })).toBe(false);
    expect(hasQuotaWarning(null)).toBe(false);
    expect(itemStateFrom({ status: 'PARTIAL_SUCCESS', lastUpdatedAt: 'x', statusDetail: detail })).toEqual({
      status: 'quota_exhausted',
      lastUpdatedAt: 'x',
    });
    // Other partial successes stay connected; 423 without PARTIAL_SUCCESS is ignored.
    expect(itemStateFrom({ status: 'PARTIAL_SUCCESS', statusDetail: { w: [{ code: '500' }] } }).status).toBe('connected');
    expect(itemStateFrom({ status: 'UPDATED', statusDetail: detail }).status).toBe('connected');
  });
});

describe('adapter: error taxonomy (table)', () => {
  const cases: Array<[string, unknown, string, number | undefined]> = [
    ['401 on data call', new PluggyError(401, 'GET /accounts — unauthorized'), 'auth', undefined],
    ['403 consent', new PluggyError(403, 'consent expired'), 'auth', undefined],
    ['429 with RateLimit-Reset', new PluggyError(429, 'slow down', undefined, 12_000), 'rate_limited', 12_000],
    ['429 without header', new PluggyError(429, 'slow down'), 'rate_limited', undefined],
    ['500', new PluggyError(500, 'boom'), 'transient', undefined],
    ['503', new PluggyError(503, 'busy'), 'transient', undefined],
    ['timeout/network (status 0)', new PluggyError(0, 'request timed out'), 'transient', undefined],
    ['404', new PluggyError(404, 'item missing'), 'permanent', undefined],
    ['400', new PluggyError(400, 'bad'), 'permanent', undefined],
    ['API-key exchange failed (our config)', new PluggyError(401, 'authentication failed — nope'), 'permanent', undefined],
    ['missing credentials', new PluggyConfigError(['PLUGGY_CLIENT_ID is required']), 'permanent', undefined],
    ['schema drift', new Error('zod: invalid'), 'transient', undefined],
  ];
  for (const [name, err, kind, retryAfterMs] of cases) {
    it(`${name} → ${kind}`, () => {
      const out = classifyPluggyError(err);
      expect(out).toBeInstanceOf(AggregatorError);
      expect(out.kind).toBe(kind as AggregatorError['kind']);
      expect(out.retryAfterMs).toBe(retryAfterMs);
    });
  }

  it('is idempotent on AggregatorError', () => {
    const e = new AggregatorError('auth', 'x');
    expect(classifyPluggyError(e)).toBe(e);
  });

  it('retry-after parsing: RateLimit-Reset wins over Retry-After; HTTP dates; garbage', () => {
    expect(retryAfterMsFrom(new Headers({ 'ratelimit-reset': '30', 'retry-after': '5' }))).toBe(30_000);
    expect(retryAfterMsFrom(new Headers({ 'retry-after': '7' }))).toBe(7_000);
    expect(retryAfterMsFrom(new Headers({ 'retry-after': new Date(110_000).toUTCString() }), () => 100_000)).toBe(10_000);
    expect(retryAfterMsFrom(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
    expect(retryAfterMsFrom(new Headers())).toBeUndefined();
  });

  it('listTransactions surfaces a 429 as rate_limited carrying RateLimit-Reset', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/accounts/a1') return { json: { id: 'a1', type: 'BANK', name: 'x', itemId: 'i' } };
      return { status: 429, text: 'too many', headers: { 'RateLimit-Reset': '42' } };
    });
    const err = await makeAggregator(fetchImpl).listTransactions('a1').catch((e) => e);
    expect(err).toBeInstanceOf(AggregatorError);
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: 42_000 });
  });

  it('getItemState: LOGIN_ERROR → unauthorized, lastUpdatedAt passed through, 401 → auth', async () => {
    const ok = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      return { json: { id: 'it1', status: 'LOGIN_ERROR', lastUpdatedAt: '2026-01-02T00:00:00Z' } };
    });
    expect(await makeAggregator(ok.fetchImpl).getItemState('it1')).toEqual({ status: 'unauthorized', lastUpdatedAt: '2026-01-02T00:00:00Z' });
    const denied = makeFetch((url) => (url.pathname === '/auth' ? authJson() : { status: 401, text: 'no' }));
    expect(await makeAggregator(denied.fetchImpl).getItemState('it1').catch((e) => e)).toMatchObject({ kind: 'auth' });
  });
});

describe('adapter: webhook actions (table)', () => {
  const agg = new PluggyAggregator({ config: cfg });
  const cases: Array<[Record<string, unknown>, string, string | undefined]> = [
    [{ event: 'transactions/created' }, 'sync', undefined],
    [{ event: 'transactions/updated' }, 'sync', undefined],
    [{ event: 'transactions/deleted' }, 'sync', undefined],
    [{ event: 'item/updated' }, 'sync', undefined],
    [{ event: 'item/waiting_user_action' }, 'status', 'unauthorized'],
    [{ event: 'item/error', error: { code: 'INVALID_CREDENTIALS' } }, 'status', 'unauthorized'],
    [{ event: 'item/error', error: { code: 'CONNECTION_ERROR' } }, 'status', 'error'],
    [{ event: 'item/error' }, 'status', 'error'],
    [{ event: 'item/created' }, 'ignore', undefined],
    [{ event: 'item/login_succeeded' }, 'ignore', undefined],
  ];
  for (const [body, action, status] of cases) {
    it(`${JSON.stringify(body)} → ${action}${status ? `/${status}` : ''}`, () => {
      const d = agg.mapWebhookDelivery({ eventId: 'e', itemId: 'it', ...body })!;
      expect(d.action).toBe(action as typeof d.action);
      expect(d.status).toBe(status as typeof d.status);
    });
  }
});

describe('adapter: hasItem', () => {
  it('true when the item is readable; false on 404/403 (another application\'s item); other failures are thrown', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson();
      if (url.pathname === '/items/mine') return { json: { id: 'mine', status: 'UPDATED' } };
      if (url.pathname === '/items/theirs') return { status: 404, json: { message: 'not found' } };
      if (url.pathname === '/items/forbidden') return { status: 403, json: { message: 'forbidden' } };
      if (url.pathname === '/items/down') return { status: 500, text: 'boom' };
      throw new Error(`unexpected ${url.pathname}`);
    });
    const agg = makeAggregator(fetchImpl);
    expect(await agg.hasItem('mine')).toBe(true);
    expect(await agg.hasItem('theirs')).toBe(false);
    expect(await agg.hasItem('forbidden')).toBe(false);
    await expect(agg.hasItem('down')).rejects.toThrow();
  });
});
