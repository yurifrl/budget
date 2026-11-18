import { describe, expect, test } from 'bun:test';
import { z } from './zod';

import { defineOperation } from './operation-contract';
import { contracts } from './contracts/budget';

import { contractRequest } from './contract-request';

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
    expect(contractRequest(c as never, { id: 'c1', budget_id: 'b', target: { amount: 50, cadence: 'monthly' } } as never).body)
      .toEqual({ amount: 50, cadence: 'monthly' });
  });

  test('a missing path param throws', () => {
    expect(() => contractRequest(byName('budget_rename') as never, { name: 'x' } as never)).toThrow(/missing path param/);
  });
});

