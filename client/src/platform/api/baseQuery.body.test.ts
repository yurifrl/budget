import { describe, expect, test } from 'bun:test';

import type { BaseQueryApi } from '@reduxjs/toolkit/query';

import { Container } from '../di/container';
import { Tokens } from '../di/tokens';
import type { KVStore } from '../storage/types';
import { apiBaseQuery } from './baseQuery';

describe('apiBaseQuery body serialization', () => {
  test('a JSON null body is sent as "null" with a content type; undefined sends nothing', async () => {
    const seen: RequestInit[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(async (_u: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(null, { status: 204 });
    }, original);
    try {
      const api = {
        signal: new AbortController().signal,
        extra: new Container()
          .registerValue(Tokens.Config, { apiUrl: 'http://x', connectionsProvider: 't' })
          .registerValue(Tokens.Storage, { get: async () => null, set: async () => {}, remove: async () => {} } as unknown as KVStore),
      } as unknown as BaseQueryApi;
      await apiBaseQuery({ url: '/a', method: 'PATCH', body: null }, api, {});
      await apiBaseQuery({ url: '/a', method: 'DELETE' }, api, {});
      expect(seen[0]!.body).toBe('null');
      expect((seen[0]!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(seen[1]!.body).toBeUndefined();
      expect(seen[0]!.signal).toBeDefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
