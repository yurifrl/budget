import { describe, expect, test } from 'bun:test';
import { z } from '@shared/zod';

import { milliunitsSchema } from '@shared/validation';
import { HttpError, parseValue, uuidSchema } from './validate';

const schema = z.object({
  budget_id: uuidSchema,
  amount_cents: z.number(),
  count: z.number().int(),
  kind: z.enum(['a', 'b']),
  tags: z.array(z.string()).max(1),
  cents: milliunitsSchema.optional(),
});

function messageOf(raw: unknown): string {
  try {
    parseValue(schema, raw);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    return (err as HttpError).message;
  }
  throw new Error('expected parseValue to throw');
}

describe('parseValue messages', () => {
  const ok = { budget_id: crypto.randomUUID(), amount_cents: 1, count: 1, kind: 'a', tags: [] };

  test('missing field is "<key> is required"', () => {
    expect(messageOf({ ...ok, budget_id: undefined })).toBe('budget_id is required');
  });
  test('bad uuid is "<key> must be a valid id"', () => {
    expect(messageOf({ ...ok, budget_id: 'nope' })).toBe('budget_id must be a valid id');
  });
  test('wrong type is "<key> must be a <type>"', () => {
    expect(messageOf({ ...ok, amount_cents: 'x' })).toBe('amount_cents must be a number');
    expect(messageOf({ ...ok, count: 1.5 })).toBe('count must be an integer');
  });
  test('enum and bounds fall back to readable text, no "invalid request" prefix', () => {
    expect(messageOf({ ...ok, kind: 'z' })).toBe('kind is not an allowed value');
    expect(messageOf({ ...ok, tags: ['a', 'b'] })).toStartWith('tags is invalid');
  });
  test('several problems are joined with "; "', () => {
    expect(messageOf({ ...ok, budget_id: undefined, amount_cents: 'x' })).toBe(
      'budget_id is required; amount_cents must be a number',
    );
  });
});

describe('error body', () => {
  test('params ride next to the code, and only when given', async () => {
    const { errorBody } = await import('./validate');
    expect(errorBody(409, 'x', 'payee_name_reserved', { name: 'Transfer : A' })).toEqual({
      error: 'x',
      code: 'payee_name_reserved',
      params: { name: 'Transfer : A' },
    });
    expect(errorBody(409, 'x', 'account_closed')).toEqual({ error: 'x', code: 'account_closed' });
    expect(errorBody(404, 'not found')).toEqual({ error: 'not found', code: 'not_found' });
  });

  test('httpOnError sends the HttpError code and params', async () => {
    const { Hono } = await import('hono');
    const { httpOnError } = await import('./validate');
    const app = new Hono();
    app.onError(httpOnError);
    app.get('/a', () => {
      throw new HttpError(409, 'closed', 'account_closed');
    });
    app.get('/b', () => {
      throw new HttpError(409, 'named', 'payee_name_exists', { name: 'Café' });
    });
    const a = await app.request('/a');
    expect(a.status).toBe(409);
    expect(await a.json()).toEqual({ error: 'closed', code: 'account_closed' });
    expect(await (await app.request('/b')).json()).toEqual({ error: 'named', code: 'payee_name_exists', params: { name: 'Café' } });
  });
});
