import { describe, expect, test } from 'bun:test';

import type { BaseQueryApi } from '@reduxjs/toolkit/query';

import { apiBaseQuery, apiErrorMessage, type ApiQuery } from './baseQuery';
import { Container } from '../di/container';
import { Tokens } from '../di/tokens';
import type { KVStore } from '../storage/types';

/**
 * Transport contract tests: every response path must resolve (never throw) so
 * RTK Query's endpoint state is always { data } or { error }.
 */

const BASE = 'http://api.test:3999';

function makeStorage(token: string | null): KVStore {
  return {
    get: async () => token,
    set: async () => {},
    remove: async () => {},
  } as unknown as KVStore;
}

function makeApi(storageToken: string | null = null, apiUrl = BASE): BaseQueryApi {
  const container = new Container()
    .registerValue(Tokens.Config, { apiUrl, connectionsProvider: 'test-provider' })
    .registerValue(Tokens.Storage, makeStorage(storageToken));
  return {
    signal: new AbortController().signal,
    abort: () => {},
    dispatch: () => {},
    getState: () => undefined,
    extra: container,
    endpoint: 'test',
    type: 'query',
  };
}

/** Repo convention: swap globalThis.fetch, restore on cleanup. */
const stubFetch = (handler: (url: string, init: RequestInit) => Promise<Response>) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (url: string, init?: RequestInit) => {
    return handler(url, init ?? {});
  }, originalFetch);
  return () => {
    globalThis.fetch = originalFetch;
  };
};

/** Thin wrapper the tests call with just query + api. */
const call = (query: ApiQuery, api: BaseQueryApi) => apiBaseQuery(query, api, {});

describe('apiBaseQuery', () => {
  test('200 parses JSON body into data', async () => {
    const restore = stubFetch(async () =>
      new Response(JSON.stringify({ items: [1, 2] }), { status: 200 }),
    );
    try {
      const result = await call({ url: '/budget/transactions' }, makeApi());
      expect(result).toEqual({ data: { items: [1, 2] } });
    } finally {
      restore();
    }
  });

  test('204 resolves data null', async () => {
    const restore = stubFetch(async () => new Response(null, { status: 204 }));
    try {
      const result = await call({ url: '/budget/month-notes' }, makeApi());
      expect(result).toEqual({ data: null });
    } finally {
      restore();
    }
  });

  test('4xx surfaces server error message with HTTP status', async () => {
    const restore = stubFetch(async () =>
      new Response(JSON.stringify({ error: 'budget_id is required' }), { status: 400 }),
    );
    try {
      const result = await call({ url: '/budget/budgets' }, makeApi());
      expect(result).toEqual({
        error: { status: 400, message: 'budget_id is required' },
      });
    } finally {
      restore();
    }
  });

  test('4xx carries the machine-readable code next to the message', async () => {
    const restore = stubFetch(async () =>
      new Response(JSON.stringify({ error: 'account is closed', code: 'conflict' }), { status: 409 }),
    );
    try {
      const result = await call({ url: '/transactions', method: 'POST' }, makeApi());
      expect(result).toEqual({ error: { status: 409, message: 'account is closed', code: 'conflict' } });
      expect(apiErrorMessage((result as { error: unknown }).error)).toBe('account is closed');
    } finally {
      restore();
    }
  });

  test('5xx with non-JSON body falls back to "HTTP <status>"', async () => {
    const restore = stubFetch(async () => new Response('<html>boom</html>', { status: 500 }));
    try {
      const result = await call({ url: '/budget/accounts' }, makeApi());
      expect(result).toEqual({ error: { status: 500, message: 'HTTP 500' } });
    } finally {
      restore();
    }
  });

  test('thrown fetch (offline) resolves as FETCH_ERROR, never throws', async () => {
    const restore = stubFetch(async () => {
      throw new TypeError('Network request failed');
    });
    try {
      const result = await call({ url: '/budget/transactions' }, makeApi());
      expect(result).toEqual({
        error: { status: 'FETCH_ERROR', message: 'Network request failed' },
      });
    } finally {
      restore();
    }
  });

  test('non-Error fetch throw becomes generic FETCH_ERROR message', async () => {
    const restore = stubFetch(async () => {
      throw 'boom';
    });
    try {
      const result = await call({ url: '/x' }, makeApi());
      expect(result).toEqual({
        error: { status: 'FETCH_ERROR', message: 'Network request failed' },
      });
    } finally {
      restore();
    }
  });

  test('stored session token rides as Authorization: Bearer', async () => {
    let seenInit: RequestInit | undefined;
    const restore = stubFetch(async (_url, init) => {
      seenInit = init;
      return new Response('null', { status: 200 });
    });
    try {
      await call({ url: '/auth/me' }, makeApi('tok-123'));
      expect(seenInit?.headers).toMatchObject({ Authorization: 'Bearer tok-123' });
    } finally {
      restore();
    }
  });

  test('body POST sends JSON body + Content-Type; plain GET does not', async () => {
    const seen: RequestInit[] = [];
    const restore = stubFetch(async (_url, init) => {
      seen.push(init);
      return new Response('null', { status: 200 });
    });
    try {
      await call(
        { url: '/budget/transactions', method: 'POST', body: { payee: 'Cafe', outflow: 500 } },
        makeApi(),
      );
      await call({ url: '/budget/accounts' }, makeApi());
      expect(seen).toHaveLength(2);
      expect(JSON.parse(seen[0].body as string)).toEqual({ payee: 'Cafe', outflow: 500 });
      expect((seen[0].headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(seen[0].method).toBe('POST');
      expect(seen[1].method).toBe('GET');
      expect((seen[1].headers as Record<string, string>)['Content-Type']).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('params are stringified, undefined entries omitted, numbers/booleans coerced', async () => {
    let seenUrl = '';
    const restore = stubFetch(async (url) => {
      seenUrl = url;
      return new Response('null', { status: 200 });
    });
    try {
      const q: ApiQuery = {
        url: '/ourtube/videos',
        params: { limit: 10, watched: false, q: 'hello world', skip: undefined },
      };
      await call(q, makeApi());
      expect(seenUrl).toBe(`${BASE}/ourtube/videos?limit=10&watched=false&q=hello+world`);
    } finally {
      restore();
    }
  });

  test('trailing slash in apiUrl does not double-slash the path', async () => {
    let seenUrl = '';
    const restore = stubFetch(async (url) => {
      seenUrl = url;
      return new Response('null', { status: 200 });
    });
    try {
      await call({ url: 'ourtube/videos' }, makeApi(null, `${BASE}/`));
      expect(seenUrl).toBe(`${BASE}/ourtube/videos`);
    } finally {
      restore();
    }
  });

  test('a Blob body is sent raw with its own content type (file uploads)', async () => {
    let seen: { body?: unknown; headers?: Record<string, string> } = {};
    const restore = stubFetch(async (_url, init) => {
      seen = { body: init.body, headers: init.headers as Record<string, string> };
      return new Response('{}', { status: 200 });
    });
    try {
      const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
      const result = await call({ url: '/me/avatar', method: 'PUT', body: blob }, makeApi());
      expect(result).toEqual({ data: {} });
      expect(seen.body).toBe(blob);
      expect(seen.headers?.['Content-Type']).toBe('image/png');
    } finally {
      restore();
    }
  });
});
