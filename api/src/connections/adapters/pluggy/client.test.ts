import { describe, it, expect } from 'bun:test';

import { PluggyClient, PluggyError, PluggyConfigError, configurePluggyEnv, loadPluggyConfig, loadPluggyOwnConfig, pluggyEnv, type FetchLike } from './client';
import adapterEntries from '../index';

const BASE = 'https://api.pluggy.ai';

const cfg = {
  pluggyClientId: 'cid',
  pluggyClientSecret: 'secret',
  pluggyBaseUrl: BASE,
  sandbox: false,
  itemIds: [],
  clientUserId: 'user-1',
};

type MockResult = { status?: number; json?: unknown; text?: string };
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
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const callsTo = (calls: RecordedCall[], path: string) => calls.filter((c) => c.url.pathname === path);

/** API-key auth response with expiry relative to `at` (matching the client's injectable clock). */
function authJson(apiKey: string, expiresInMs?: number, at = Date.now()): MockResult {
  return {
    json: {
      apiKey,
      ...(expiresInMs !== undefined ? { expirationDate: new Date(at + expiresInMs).toISOString() } : {}),
    },
  };
}

function itemPage(page: number, totalPages: number, clientUserId = 'user-1'): MockResult {
  return {
    json: {
      results: [{ id: `it${page}`, connectorId: 1, status: 'UPDATED', clientUserId }],
      page,
      totalPages,
    },
  };
}

function txnResult(nextPage: string | null): MockResult {
  return {
    json: {
      results: [{ id: 'tx1', accountId: 'ac1', amount: -12.5, date: '2026-01-05', description: 'coffee' }],
      nextPage,
    },
  };
}

const unexpected = (url: URL): never => {
  throw new Error(`unexpected ${url.pathname}`);
};

describe('pluggy config', () => {
  it('loads credentials from the source repo env var names', () => {
    const c = loadPluggyConfig({
      PLUGGY_CLIENT_ID: 'env-id',
      PLUGGY_CLIENT_SECRET: 'env-secret',
      PLUGGY_BASE_URL: 'https://api.pluggy.ai/',
      PLUGGY_SANDBOX: '0',
      PLUGGY_ITEM_IDS: ' it1 , it2 ',
      CLIENT_USER_ID: 'user-env',
    });
    expect(c).toEqual({
      pluggyClientId: 'env-id',
      pluggyClientSecret: 'env-secret',
      pluggyBaseUrl: 'https://api.pluggy.ai',
      sandbox: false,
      itemIds: ['it1', 'it2'],
      clientUserId: 'user-env',
    });
  });

  it('applies source defaults (base url, sandbox true, empty item ids)', () => {
    const c = loadPluggyConfig({ PLUGGY_CLIENT_ID: 'id', PLUGGY_CLIENT_SECRET: 's' });
    expect(c.pluggyBaseUrl).toBe('https://api.pluggy.ai');
    expect(c.sandbox).toBe(true);
    expect(c.itemIds).toEqual([]);
  });

  it('rejects a missing client id/secret with one bullet per issue', () => {
    expect(() => loadPluggyConfig({})).toThrow(PluggyConfigError);
    const issues = (() => {
      try {
        loadPluggyConfig({});
      } catch (err) {
        return (err as PluggyConfigError).issues;
      }
      return [] as string[];
    })();
    expect(issues).toHaveLength(2);
  });

  it('rejects an empty-string client id with a named bullet', () => {
    try {
      loadPluggyConfig({ PLUGGY_CLIENT_ID: '', PLUGGY_CLIENT_SECRET: 's' });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(PluggyConfigError);
      expect((err as PluggyConfigError).issues[0]).toContain('PLUGGY_CLIENT_ID is required');
    }
  });

  it('fails on first use, never at import time', async () => {
    // Hermetic: `{}` replaces process.env, so this passes even on a dev machine
    // whose real .env carries valid PLUGGY_* values.
    const client = new PluggyClient(() => loadPluggyConfig({}));
    await expect(client.getApiKey()).rejects.toThrow(PluggyConfigError);
  });
});

describe('api key cache + single-flight', () => {
  it('mints an api key with clientId/clientSecret and caches it across calls', async () => {
    const { calls, fetchImpl } = makeFetch((url) => (url.pathname === '/auth' ? authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000) : unexpected(url)));
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    expect(await client.getApiKey()).toBe('key-1');
    expect(await client.getApiKey()).toBe('key-1');
    const auth = callsTo(calls, '/auth');
    expect(auth).toHaveLength(1);
    expect(auth[0].init.method).toBe('POST');
    expect(JSON.parse(String(auth[0].init.body))).toEqual({ clientId: 'cid', clientSecret: 'secret' });
  });

  it('single-flights N concurrent callers into exactly one POST /auth', async () => {
    const { calls, fetchImpl } = makeFetch(async (url) => {
      if (url.pathname === '/auth') {
        await Promise.resolve(); // yield once so every concurrent caller has entered
        return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      }
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const pending = [client.getApiKey(), client.getApiKey(), client.getApiKey(), client.getApiKey(), client.getApiKey()];
    expect(await Promise.all(pending)).toEqual(['key-1', 'key-1', 'key-1', 'key-1', 'key-1']);
    expect(callsTo(calls, '/auth')).toHaveLength(1);
  });

  it('refreshes inside the 60s refresh margin but not outside it', async () => {
    let nowMs = 1_000_000;
    const { calls, fetchImpl } = makeFetch((url) => (url.pathname === '/auth' ? authJson('key-1', 30_000, nowMs) : unexpected(url)));
    const client = new PluggyClient(cfg, fetchImpl, () => nowMs);
    expect(await client.getApiKey()).toBe('key-1');
    nowMs += 120_000; // expiry in 30s < margin 60s → re-fetch
    expect(await client.getApiKey()).toBe('key-1');
    expect(callsTo(calls, '/auth')).toHaveLength(2);
  });

  it('keeps the cached key while more than the margin remains', async () => {
    let nowMs = 1_000_000;
    const { calls, fetchImpl } = makeFetch((url) => (url.pathname === '/auth' ? authJson('key-1', 61_000, 1_000_000) : unexpected(url)));
    const client = new PluggyClient(cfg, fetchImpl, () => nowMs);
    expect(await client.getApiKey()).toBe('key-1'); // 61s remaining > 60s margin
    nowMs += 500;
    expect(await client.getApiKey()).toBe('key-1'); // 60.5s remaining → still cached
    nowMs += 5_000; // 55.5s remaining < margin → re-fetch
    expect(await client.getApiKey()).toBe('key-1');
    expect(callsTo(calls, '/auth')).toHaveLength(2);
  });

  it('falls back to a 2h expiry when expirationDate is missing or unparseable', async () => {
    let nowMs = 1_000_000;
    let flavor: 'missing' | 'invalid' = 'missing';
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') {
        return flavor === 'missing' ? { json: { apiKey: 'key-1' } } : { json: { apiKey: 'key-1', expirationDate: 'not-a-date' } };
      }
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => nowMs);
    expect(await client.getApiKey()).toBe('key-1');
    nowMs += 60 * 60 * 1000; // 1h < 2h fallback → cached
    expect(await client.getApiKey()).toBe('key-1');
    nowMs += 3 * 60 * 60 * 1000; // past the fallback → re-fetch
    flavor = 'invalid'; // Date.parse NaN → same fallback applies
    expect(await client.getApiKey()).toBe('key-1');
    expect(callsTo(calls, '/auth')).toHaveLength(2);
  });

  it('surfaces auth failure as a typed PluggyError', async () => {
    const { fetchImpl } = makeFetch((url) => (url.pathname === '/auth' ? { status: 401, json: { message: 'bad credentials' } } : unexpected(url)));
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const err = await client.getApiKey().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluggyError);
    expect((err as PluggyError).status).toBe(401);
    expect((err as PluggyError).message).toContain('authentication failed');
  });
});

describe('core request error handling', () => {
  it('retries once on 401 after invalidating the key', async () => {
    let authN = 0;
    let itemCount = 0;
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') {
        authN++;
        return authJson(`key-${authN}`, 2 * 60 * 60 * 1000, 1_000_000);
      }
      if (url.pathname === '/items') {
        itemCount++;
        return itemCount === 1 ? { status: 401, json: { message: 'expired' } } : itemPage(1, 1);
      }
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    expect((await client.listItems()).map((i) => i.id)).toEqual(['it1']);
    expect(callsTo(calls, '/auth')).toHaveLength(2); // initial mint + re-mint after invalidate
    const items = callsTo(calls, '/items');
    expect(items).toHaveLength(2);
    expect((items[1].init.headers as Record<string, string>)['X-API-KEY']).toBe('key-2');
  });

  it('skips the 401 retry when retryOn401 is disabled', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/items/it9') return { status: 404, json: { message: 'not found' } };
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const err = await client.request('GET', '/items/it9', { retryOn401: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluggyError);
    expect((err as PluggyError).status).toBe(404);
    expect((err as PluggyError).message).toContain('GET /items/it9 — {"message":"not found"}');
    expect(callsTo(calls, '/items/it9')).toHaveLength(1);
  });

  it('maps timeouts and network failures to PluggyError(0)', async () => {
    const timeoutFetch: FetchLike = async () => {
      const e = new Error('The operation was aborted');
      e.name = 'TimeoutError';
      throw e;
    };
    const client = new PluggyClient(cfg, timeoutFetch, () => 1_000_000);
    const err = (await client.getItem('it1').catch((e: unknown) => e)) as PluggyError;
    expect(err.status).toBe(0);
    expect(err.message).toContain('request timed out after 20000ms');

    const boomFetch: FetchLike = async () => {
      throw new Error('boom');
    };
    const client2 = new PluggyClient(cfg, boomFetch, () => 1_000_000);
    const err2 = (await client2.getItem('it1').catch((e: unknown) => e)) as PluggyError;
    expect(err2.message).toBe('Pluggy API 0: request failed (boom)');
  });

  it('returns undefined on 204 without parsing a body', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/items/it1') return { status: 204 };
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    await expect(client.deleteItem('it1')).resolves.toBeUndefined();
    expect(callsTo(calls, '/items/it1')[0].init.method).toBe('DELETE');
  });
});

describe('connect token', () => {
  const connectTokenFetch = () =>
    makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/connect_token') return { json: { accessToken: 'ct-1', connectUrl: 'https://connect.pluggy.ai/ct-1' } };
      return unexpected(url);
    });

  it('passes options through: clientUserId override, webhookUrl, oauthRedirectUri, avoidDuplicates', async () => {
    const { calls, fetchImpl } = connectTokenFetch();
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const token = await client.createConnectToken({
      clientUserId: 'override-user',
      webhookUrl: 'https://wh.example',
      oauthRedirectUri: 'https://cb.example',
      avoidDuplicates: true,
    });
    expect(token).toEqual({ accessToken: 'ct-1', connectUrl: 'https://connect.pluggy.ai/ct-1' });
    const body = JSON.parse(String(callsTo(calls, '/connect_token')[0].init.body));
    expect(body).toEqual({
      clientUserId: 'override-user',
      sandbox: false,
      webhookUrl: 'https://wh.example',
      oauthRedirectUri: 'https://cb.example',
      avoidDuplicates: true,
    });
  });

  it('parses the production shape: {accessToken} only, connectUrl absent (live-traffic regression)', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/connect_token') return { json: { accessToken: 'ct-p' } };
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const token = await client.createConnectToken({ clientUserId: 'u-1' });
    expect(token).toEqual({ accessToken: 'ct-p', connectUrl: undefined });
  });

  it('defaults clientUserId/sandbox from config when no options given', async () => {
    const { calls, fetchImpl } = connectTokenFetch();
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    await client.createConnectToken({});
    expect(JSON.parse(String(callsTo(calls, '/connect_token')[0].init.body))).toEqual({ clientUserId: 'user-1', sandbox: false });
  });

  it('itemId selects the re-auth variant (token for an existing item)', async () => {
    const { calls, fetchImpl } = connectTokenFetch();
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    await client.createConnectToken({ itemId: 'it7' });
    const body = JSON.parse(String(callsTo(calls, '/connect_token')[0].init.body));
    expect(body.itemId).toBe('it7');
    expect(body.connectorId).toBeUndefined();
  });

  it('connectorId mints a token for a new connection', async () => {
    const { calls, fetchImpl } = connectTokenFetch();
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    await client.createConnectToken({ connectorId: 9 });
    const body = JSON.parse(String(callsTo(calls, '/connect_token')[0].init.body));
    expect(body.connectorId).toBe(9);
    expect(body.itemId).toBeUndefined();
  });
});

describe('pagination', () => {
  it('walks pages until hasMore is false', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/items') return itemPage(Number(url.searchParams.get('page')), 3);
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    expect((await client.listItems()).map((i) => i.id)).toEqual(['it1', 'it2', 'it3']);
    const items = callsTo(calls, '/items');
    expect(items.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(items[0].url.searchParams.get('pageSize')).toBe('100');
  });

  it('filters /items listing by the config clientUserId', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/items') return itemPage(Number(url.searchParams.get('page')), 1, 'someone-else');
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    expect(await client.listItems()).toEqual([]);
  });

  it('stops page loops at the MAX_PAGES cap', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/items') return itemPage(Number(url.searchParams.get('page')), 99);
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    expect(await client.listItems()).toHaveLength(20); // one per capped page
    expect(callsTo(calls, '/items')).toHaveLength(20);
  });

  it('listTransactions follows cursors with accountId only and filters the window client-side', async () => {
    let n = 0;
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/v2/transactions') {
        n++;
        return n === 1
          ? { json: { results: [{ id: 'tx1', accountId: 'ac1', amount: -12.5, date: '2026-01-05', description: 'coffee' }], nextPage: '/v2/transactions?accountId=ac1&cursor=cur2' } }
          : { json: { results: [{ id: 'tx2', accountId: 'ac1', amount: 5, date: '2026-02-20', description: 'late' }], nextPage: null } };
      }
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const pulled = await client.listTransactions({ accountId: 'ac1', from: '2026-01-01', to: '2026-02-01' });
    // v2 rejects date params — only accountId + cursor may be sent; the
    // out-of-window page-2 row is dropped client-side.
    expect(pulled.results.map((t) => t.id)).toEqual(['tx1']);
    expect(pulled.hasMore).toBe(false); // cursor chain ended naturally
    const tx = callsTo(calls, '/v2/transactions');
    expect(tx).toHaveLength(2);
    expect(tx[0].url.searchParams.get('cursor')).toBeNull();
    expect(tx[0].url.searchParams.get('accountId')).toBe('ac1');
    expect(tx[0].url.searchParams.get('from')).toBeNull();
    expect(tx[0].url.searchParams.get('pageSize')).toBeNull();
    expect(tx[1].url.searchParams.get('cursor')).toBe('cur2');
  });

  it('listTransactions stops paging once a page dips below the from bound', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/v2/transactions') {
        // Newest-first ordering: an older row on page 1 proves nothing older
        // can re-enter the window, so page 2 must never be fetched.
        return {
          json: {
            results: [
              { id: 'tx1', accountId: 'ac1', amount: -12.5, date: '2026-01-05', description: 'in window' },
              { id: 'tx0', accountId: 'ac1', amount: -3, date: '2025-12-31', description: 'below from' },
            ],
            nextPage: '/v2/transactions?cursor=cur2',
          },
        };
      }
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const pulled = await client.listTransactions({ accountId: 'ac1', from: '2026-01-01' });
    expect(pulled.results.map((t) => t.id)).toEqual(['tx1']);
    expect(pulled.hasMore).toBe(false);
    expect(callsTo(calls, '/v2/transactions')).toHaveLength(1);
  });

  it('listTransactions accepts credit card metadata without billId', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/v2/transactions') {
        return {
          json: {
            results: [{ id: 'tx1', accountId: 'ac1', amount: -12.5, date: '2026-01-05', description: 'open bill', creditCardMetadata: { installmentNumber: 1 } }],
            nextPage: null,
          },
        };
      }
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const pulled = await client.listTransactions({ accountId: 'ac1' });
    expect(pulled.results.map((t) => t.id)).toEqual(['tx1']);
  });

  it('listTransactions keeps a same-day timestamped row at the to bound', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/v2/transactions') {
        return {
          json: {
            results: [{ id: 'tx1', accountId: 'ac1', amount: -12.5, date: '2026-02-01T23:00:00.000Z', description: 'boundary' }],
            nextPage: null,
          },
        };
      }
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const pulled = await client.listTransactions({ accountId: 'ac1', to: '2026-02-01' });
    expect(pulled.results).toHaveLength(1);
  });

  it('listTransactions stops at the page valve when cursors never end', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/v2/transactions') return txnResult('cur-forever');
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const capped = await client.listTransactions({ accountId: 'ac1', maxPages: 20 });
    expect(capped.hasMore).toBe(true); // cursor never ended within the valve
    expect(capped.cursor).toBe('cursor=cur-forever');
    expect(capped.pages).toBe(20);
    expect(callsTo(calls, '/v2/transactions')).toHaveLength(20);
  });

  it('listTransactions pages past the old 20-page cap up to maxResults', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/v2/transactions') return txnResult('cur-forever');
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const pulled = await client.listTransactions({ accountId: 'ac1', maxResults: 60 });
    expect(pulled.results).toHaveLength(60);
    expect(callsTo(calls, '/v2/transactions')).toHaveLength(60);
  });

  it('listTransactions stops after the page that reaches maxResults and returns where to resume', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/v2/transactions') return txnResult('cur2');
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    // txnResult yields one txn per page, so maxResults 1 is satisfied by page 1 — no second fetch.
    const sliced = await client.listTransactions({ accountId: 'ac1', maxResults: 1 });
    expect(sliced.results).toHaveLength(1);
    expect(sliced.hasMore).toBe(true); // a second transaction exists beyond the cap
    expect(sliced.cursor).toBe('cursor=cur2');
    expect(callsTo(calls, '/v2/transactions')).toHaveLength(1);
  });

  it('listTransactions follows the `next` query-string shape with `after`', async () => {
    let n = 0;
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/v2/transactions') {
        n++;
        return n === 1
          ? { json: { results: [{ id: 'tx2', accountId: 'ac1', amount: -1, date: '2026-02-05', description: 'b' }], next: 'accountId=ac1&after=abc%3D%3D' } }
          : { json: { results: [{ id: 'tx1', accountId: 'ac1', amount: -1, date: '2026-01-05', description: 'a' }], next: null } };
      }
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const pulled = await client.listTransactions({ accountId: 'ac1' });
    expect(pulled.results.map((t) => t.id)).toEqual(['tx2', 'tx1']);
    expect(pulled.hasMore).toBe(false);
    expect(pulled.oldestDate).toBe('2026-01-05');
    const tx = callsTo(calls, '/v2/transactions');
    expect(tx[1].url.searchParams.get('after')).toBe('abc==');
    expect(tx[1].url.searchParams.get('accountId')).toBe('ac1');
    expect(tx[1].url.searchParams.get('cursor')).toBeNull();
  });

  it('listTransactions resumes from a stored cursor, and restarts from the newest page when it is refused', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/v2/transactions') {
        const after = url.searchParams.get('after');
        if (after === 'good') return { json: { results: [{ id: 'old', accountId: 'ac1', amount: -1, date: '2025-01-01', description: 'old' }], next: null } };
        if (after === 'expired') return { status: 400, json: { message: 'Invalid cursor' } };
        return { json: { results: [{ id: 'new', accountId: 'ac1', amount: -1, date: '2026-01-01', description: 'new' }, { id: 'mid', accountId: 'ac1', amount: -1, date: '2025-06-01', description: 'mid' }], next: null } };
      }
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const resumed = await client.listTransactions({ accountId: 'ac1', cursor: 'after=good' });
    expect(resumed.results.map((t) => t.id)).toEqual(['old']);
    const restarted = await client.listTransactions({ accountId: 'ac1', cursor: 'after=expired', to: '2025-06-01' });
    // Rows newer than `to` (already imported) are not collected.
    expect(restarted.results.map((t) => t.id)).toEqual(['mid']);
    expect(callsTo(calls, '/v2/transactions')).toHaveLength(3);
  });
});

describe('zod response parsing', () => {
  it('getItem parses through the Item schema', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/items/it1') {
        return { json: { id: 'it1', connectorId: 5, status: 'UPDATED', clientUserId: 'user-1', lastUpdatedAt: '2026-01-02' } };
      }
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    const item = await client.getItem('it1');
    expect(item.id).toBe('it1');
    expect(item.connectorId).toBe(5);
    expect(item.status).toBe('UPDATED');
  });

  it('rejects payloads that fail the Item schema', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/items/it1') return { json: { id: 42 } };
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    await expect(client.getItem('it1')).rejects.toThrow();
  });

  it('listAccounts passes itemId/type through the query and parses accounts', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/accounts') {
        return {
          json: {
            results: [{ id: 'ac1', itemId: 'it1', type: 'CREDIT', name: 'card', balance: 100.5, currencyCode: 'BRL' }],
            totalPages: 1,
          },
        };
      }
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    expect((await client.listAccounts({ itemId: 'it1', type: 'CREDIT' })).map((a) => a.id)).toEqual(['ac1']);
    const q = callsTo(calls, '/accounts')[0].url.searchParams;
    expect(q.get('itemId')).toBe('it1');
    expect(q.get('type')).toBe('CREDIT');
    expect(q.get('page')).toBe('1');
  });

  it('listTransactions parses each page through the Transaction schema and rejects bad rows', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/v2/transactions') return { json: { results: [{ id: 1 }], nextPage: null } };
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    await expect(client.listTransactions({ accountId: 'ac1' })).rejects.toThrow();
  });

  it('getAccountBalance hits the balance subresource', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/accounts/ac1/balance') return { json: { id: 'ac1', itemId: 'it1', type: 'BANK', balance: 7 } };
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    expect((await client.getAccountBalance('ac1')).balance).toBe(7);
    expect(callsTo(calls, '/accounts/ac1/balance')).toHaveLength(1);
  });

  it('updateItem sends a PATCH with an empty JSON body', async () => {
    const { calls, fetchImpl } = makeFetch((url) => {
      if (url.pathname === '/auth') return authJson('key-1', 2 * 60 * 60 * 1000, 1_000_000);
      if (url.pathname === '/items/it1') return { json: { id: 'it1', connectorId: 1, status: 'UPDATING' } };
      return unexpected(url);
    });
    const client = new PluggyClient(cfg, fetchImpl, () => 1_000_000);
    expect((await client.updateItem('it1')).status).toBe('UPDATING');
    const call = callsTo(calls, '/items/it1')[0];
    expect(call.init.method).toBe('PATCH');
    expect(String(call.init.body)).toBe('{}');
  });
});

describe("a user's own key set", () => {
  const own = { clientId: 'own-id', clientSecret: 'own-secret' };

  it('own config: the user\'s pair on the installation\'s base URL and sandbox switch, never the shared ids or item ids', () => {
    expect(
      loadPluggyOwnConfig(own, {
        PLUGGY_CLIENT_ID: 'shared-id',
        PLUGGY_CLIENT_SECRET: 'shared-secret',
        PLUGGY_BASE_URL: 'https://api.pluggy.ai/',
        PLUGGY_SANDBOX: 'false',
        PLUGGY_ITEM_IDS: 'shared-item-1,shared-item-2',
      }),
    ).toEqual({
      pluggyClientId: 'own-id',
      pluggyClientSecret: 'own-secret',
      pluggyBaseUrl: 'https://api.pluggy.ai',
      sandbox: false,
      itemIds: [],
      clientUserId: 'syscd-app',
    });
  });

  it('own config needs no shared credentials, and blank env values count as unset', () => {
    // The 1Password item leaves PLUGGY_* empty; External Secrets passes them as ''.
    const c = loadPluggyOwnConfig(own, { PLUGGY_CLIENT_ID: '', PLUGGY_CLIENT_SECRET: '', PLUGGY_BASE_URL: '', PLUGGY_SANDBOX: '', CLIENT_USER_ID: '' });
    expect(c).toMatchObject({ pluggyClientId: 'own-id', pluggyBaseUrl: 'https://api.pluggy.ai', sandbox: true, clientUserId: 'syscd-app' });
    expect(() => loadPluggyOwnConfig(own, { PLUGGY_BASE_URL: 'not a url' })).toThrow(PluggyConfigError);
  });

  it('verifyCredentials: one POST /auth with the pair; 200 → true, 401/400/403 → false', async () => {
    const ok = makeFetch(() => authJson('k'));
    expect(await new PluggyClient(cfg, ok.fetchImpl).verifyCredentials()).toBe(true);
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]!.url.pathname).toBe('/auth');
    expect(ok.calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(ok.calls[0]!.init.body))).toEqual({ clientId: 'cid', clientSecret: 'secret' });

    for (const status of [401, 400, 403]) {
      const refused = makeFetch(() => ({ status, json: { message: 'Client keys are invalid' } }));
      expect(await new PluggyClient(cfg, refused.fetchImpl).verifyCredentials()).toBe(false);
      expect(refused.calls).toHaveLength(1);
    }
  });

  it('verifyCredentials: an outage is thrown, not reported as a wrong pair', async () => {
    const down = makeFetch(() => ({ status: 503, text: 'unavailable' }));
    const err = await new PluggyClient(cfg, down.fetchImpl).verifyCredentials().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluggyError);
    expect((err as PluggyError).status).toBe(503);
    expect((err as PluggyError).message).not.toContain('secret');
  });

  it('the registry entry builds the aggregator on the own pair (no shared keys in the env), and on the shared pair without one', async () => {
    const before = pluggyEnv();
    const realFetch = globalThis.fetch;
    const seen: Array<{ clientId: string; clientSecret: string }> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ apiKey: 'k' }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      configurePluggyEnv({});
      expect(adapterEntries.pluggy!.configured()).toBe(false);
      expect(await adapterEntries.pluggy!.create(own).verifyCredentials()).toBe(true);
      expect(adapterEntries.pluggy!.create(own).environment).toBe('sandbox');

      configurePluggyEnv({ PLUGGY_CLIENT_ID: 'shared-id', PLUGGY_CLIENT_SECRET: 'shared-secret', PLUGGY_SANDBOX: 'false' });
      expect(await adapterEntries.pluggy!.create().verifyCredentials()).toBe(true);
      expect(await adapterEntries.pluggy!.create(own).verifyCredentials()).toBe(true);
      expect(adapterEntries.pluggy!.create(own).environment).toBe('production');
      expect(seen).toEqual([own, { clientId: 'shared-id', clientSecret: 'shared-secret' }, own]);
    } finally {
      globalThis.fetch = realFetch;
      configurePluggyEnv(before);
    }
  });
});
