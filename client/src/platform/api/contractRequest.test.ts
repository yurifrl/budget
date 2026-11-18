import { describe, expect, test } from 'bun:test';
import { z } from '@shared/zod';

import { defineOperation } from '@shared/operation-contract';
import { contracts } from '@shared/contracts/budget';

import type { BaseQueryApi } from '@reduxjs/toolkit/query';

import { Container } from '../di/container';
import { Tokens } from '../di/tokens';
import type { KVStore } from '../storage/types';
import { apiBaseQuery } from './baseQuery';
import { contractRequest } from './contractRequest';

const E = { api: true, cli: true, mcp: true } as const;
const byName = (n: string) => contracts.find((c) => c.name === n)!;

describe('contractRequest', () => {
  test('GET: non-path keys go to the query string, undefined omitted', () => {
    const op = defineOperation({
      name: 'x_list', description: 'x', input: z.object({ budget_id: z.string(), hidden: z.string().optional() }),
      method: 'GET', path: '/payees', kind: 'read', expose: E,
    });
    expect(contractRequest(op, { budget_id: 'b1' })).toEqual({ url: '/payees', method: 'GET', params: { budget_id: 'b1' } });
  });

  test('path params are substituted and URL-encoded and kept out of the body', () => {
    const op = defineOperation({
      name: 'x_set', description: 'x', input: z.object({ id: z.string(), budget_id: z.string(), name: z.string() }),
      method: 'PATCH', path: '/things/:id/name', query: ['budget_id'], kind: 'write', expose: E,
    });
    expect(contractRequest(op, { id: 'a/b', budget_id: 'b1', name: 'N' })).toEqual({
      url: '/things/a%2Fb/name', method: 'PATCH', params: { budget_id: 'b1' }, body: { name: 'N' },
    });
  });

  test('POST: all non-path keys go to the JSON body, undefined keys dropped', () => {
    const c = byName('budget_assignments_set');
    expect(contractRequest(c as never, { budget_id: 'b', month: '2026-11-01', category_id: 'c', budgeted: 10 } as never)).toEqual({
      url: '/assignments', method: 'POST', body: { budget_id: 'b', month: '2026-11-01', category_id: 'c', budgeted: 10 },
    });
    const t = byName('budget_transactions_delete');
    expect(contractRequest(t as never, { id: 'i', budget_id: 'b', deltas: undefined } as never)).toEqual({
      url: '/transactions/i', method: 'DELETE', params: { budget_id: 'b' },
    });
  });

  test('bodyKey: the body is that key\'s value, including null (clear)', () => {
    const c = byName('budget_categories_set_target');
    expect(contractRequest(c as never, { id: 'c1', budget_id: 'b', target: null } as never)).toEqual({
      url: '/categories/c1/target', method: 'PATCH', params: { budget_id: 'b' }, body: null,
    });
    expect(contractRequest(c as never, { id: 'c1', budget_id: 'b', target: { amount_cents: 5, cadence: 'monthly' } } as never).body)
      .toEqual({ amount_cents: 5, cadence: 'monthly' });
  });

  test('a missing path param throws', () => {
    expect(() => contractRequest(byName('budget_rename') as never, { name: 'x' } as never)).toThrow(/missing path param/);
  });
});

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
