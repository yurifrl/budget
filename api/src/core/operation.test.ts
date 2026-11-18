/**
 * Tests for the operation layer: contracts (input location mapping),
 * mountOperations (validated input, status/response conventions, the {error}
 * shape, middleware, basePath) and createApiClient.call round-tripping
 * through a mounted app in-process. No DB.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from '@shared/zod';

import { ApiError, createApiClient } from './client';
import { defineOperation, inputLocations, pathParamNames } from '@shared/operation-contract';
import { implement, mountOperations, type AnyOperation } from './operation';
import { HttpError, httpOnError, uuidSchema } from './validate';

const ALL = { api: true, cli: true, mcp: true } as const;
const ID = '11111111-1111-4111-8111-111111111111';

const getItem = defineOperation({
  name: 'test_items_get',
  description: 'get',
  input: z.object({ id: uuidSchema, scope: uuidSchema, limit: z.coerce.number().int().min(1).max(5).default(2) }),
  method: 'GET',
  path: '/items/:id',
  kind: 'read',
  expose: ALL,
});

const createItem = defineOperation({
  name: 'test_items_create',
  description: 'create',
  input: z.object({ scope: uuidSchema, name: z.string().min(1), tags: z.array(z.string()).optional() }),
  method: 'POST',
  path: '/items',
  status: 201,
  kind: 'write',
  expose: ALL,
});

const patchItem = defineOperation({
  name: 'test_items_patch',
  description: 'patch',
  input: z.object({ id: uuidSchema, scope: uuidSchema, name: z.string().min(1) }),
  method: 'PATCH',
  path: '/items/:id',
  query: ['scope'],
  kind: 'write',
  expose: ALL,
});

const deleteItem = defineOperation({
  name: 'test_items_delete',
  description: 'delete',
  input: z.object({ id: uuidSchema, scope: uuidSchema, reason: z.string().optional() }),
  method: 'DELETE',
  path: '/items/:id',
  query: ['scope'],
  kind: 'destructive',
  expose: ALL,
});

const setTarget = defineOperation({
  name: 'test_items_target',
  description: 'whole body is the target (nullable)',
  input: z.object({ id: uuidSchema, target: z.object({ amount: z.number() }).nullable() }),
  method: 'PATCH',
  path: '/items/:id/target',
  bodyKey: 'target',
  kind: 'write',
  expose: ALL,
});

const hidden = defineOperation({
  name: 'test_hidden',
  description: 'not exposed on the api',
  input: z.object({}),
  method: 'GET',
  path: '/hidden',
  kind: 'read',
  expose: { api: false, cli: true, mcp: true },
});

const custom = defineOperation({
  name: 'test_custom',
  description: 'handler returns a Response',
  input: z.object({}),
  method: 'POST',
  path: '/custom',
  kind: 'write',
  expose: ALL,
});

const boom = defineOperation({
  name: 'test_boom',
  description: 'throws HttpError',
  input: z.object({}),
  method: 'GET',
  path: '/boom',
  kind: 'read',
  expose: ALL,
});

const seen: Record<string, unknown> = {};

const ops: AnyOperation[] = [
  implement(getItem, (_c, input) => {
    seen.get = input;
    return { ok: true, input };
  }),
  implement(createItem, (_c, input) => {
    seen.create = input;
    return { id: ID, ...input };
  }),
  implement(patchItem, (_c, input) => {
    seen.patch = input;
  }),
  implement(deleteItem, (_c, input) => {
    seen.delete = input;
  }),
  implement(setTarget, (_c, input) => {
    seen.target = input;
    return input;
  }),
  implement(hidden, () => ({ nope: true })),
  implement(custom, (c) => c.json({ error: 'conflict-ish' }, 409)),
  implement(boom, () => {
    throw new HttpError(418, 'teapot');
  }),
];

function build(options?: Parameters<typeof mountOperations>[2]): Hono {
  const app = new Hono();
  app.onError(httpOnError);
  mountOperations(app, ops, options);
  return app;
}

const S = '22222222-2222-4222-8222-222222222222';
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('contract input locations', () => {
  test('path params come from the template', () => {
    expect(pathParamNames('/a/:id/b/:other_id')).toEqual(['id', 'other_id']);
    expect(pathParamNames('/plain')).toEqual([]);
  });

  test('GET: every non-path key is query', () => {
    expect(inputLocations(getItem)).toEqual({ path: ['id'], query: ['scope', 'limit'], body: [] });
  });

  test('POST: body by default; explicit query list moves keys to the query string', () => {
    expect(inputLocations(createItem)).toEqual({ path: [], query: [], body: ['scope', 'name', 'tags'] });
    expect(inputLocations(patchItem)).toEqual({ path: ['id'], query: ['scope'], body: ['name'] });
    expect(inputLocations(deleteItem)).toEqual({ path: ['id'], query: ['scope'], body: ['reason'] });
  });

  test('bodyKey: no body object keys, the body is the key itself', () => {
    expect(inputLocations(setTarget)).toEqual({ path: ['id'], query: [], body: [] });
  });
});

describe('mountOperations', () => {
  const app = build();

  test('GET: path + query merged, coerced and defaulted', async () => {
    const res = await app.request(`/items/${ID}?scope=${S}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, input: { id: ID, scope: S, limit: 2 } });
    const res2 = await app.request(`/items/${ID}?scope=${S}&limit=4`);
    expect(((await res2.json()) as { input: { limit: number } }).input.limit).toBe(4);
  });

  test('POST: body fields validated; contract status applied (201)', async () => {
    const res = await app.request('/items', json({ scope: S, name: 'x', ignored: 1 }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: ID, scope: S, name: 'x' });
    expect(seen.create).toEqual({ scope: S, name: 'x' });
  });

  test('PATCH: query + path + body; handler returning nothing is 204 with no body', async () => {
    const res = await app.request(`/items/${ID}?scope=${S}`, { ...json({ name: 'n' }), method: 'PATCH' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(seen.patch).toEqual({ id: ID, scope: S, name: 'n' });
  });

  test('DELETE with a body: query for scope, JSON body for the rest; body is optional', async () => {
    const withBody = await app.request(`/items/${ID}?scope=${S}`, { ...json({ reason: 'why' }), method: 'DELETE' });
    expect(withBody.status).toBe(204);
    expect(seen.delete).toEqual({ id: ID, scope: S, reason: 'why' });
    const noBody = await app.request(`/items/${ID}?scope=${S}`, { method: 'DELETE' });
    expect(noBody.status).toBe(204);
    expect(seen.delete).toEqual({ id: ID, scope: S });
  });

  test('bodyKey: the whole JSON body (including null) is the key value', async () => {
    const obj = await app.request(`/items/${ID}/target`, { ...json({ amount: 5 }), method: 'PATCH' });
    expect(await obj.json()).toEqual({ id: ID, target: { amount: 5 } });
    const nul = await app.request(`/items/${ID}/target`, { ...json(null), method: 'PATCH' });
    expect(nul.status).toBe(200);
    expect(seen.target).toEqual({ id: ID, target: null });
  });

  test('validation failures are 400 with the {error, code} shape (path, query, body)', async () => {
    const badPath = await app.request(`/items/not-a-uuid?scope=${S}`);
    expect(badPath.status).toBe(400);
    const badPathBody = (await badPath.json()) as { error: string; code: string };
    expect(Object.keys(badPathBody)).toEqual(['error', 'code']);
    expect(badPathBody.code).toBe('invalid_input');
    expect(badPathBody.error).toBe('id must be a valid id');

    const missingQuery = await app.request(`/items/${ID}`);
    expect(missingQuery.status).toBe(400);
    expect(await missingQuery.json()).toEqual({ error: 'scope is required', code: 'invalid_input' });

    const badCoerce = await app.request(`/items/${ID}?scope=${S}&limit=99`);
    expect(badCoerce.status).toBe(400);

    const badBody = await app.request('/items', json({ scope: S, name: '' }));
    expect(badBody.status).toBe(400);
    expect(((await badBody.json()) as { error: string }).error).toMatch(/^name /);

    const wrongType = await app.request('/items', json({ scope: S, name: 5 }));
    expect(await wrongType.json()).toEqual({ error: 'name must be a string', code: 'invalid_input' });

    const badJson = await app.request('/items', { ...json(null), body: '{nope' });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: 'request body must be valid JSON', code: 'invalid_input' });

    const notObject = await app.request('/items', json([1]));
    expect(notObject.status).toBe(400);
    expect(await notObject.json()).toEqual({ error: 'request body must be a JSON object', code: 'invalid_input' });

    const empty = await app.request('/items', { method: 'POST' });
    expect(empty.status).toBe(400);
  });

  test('a returned Response passes through; thrown HttpError becomes {error}', async () => {
    const res = await app.request('/custom', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict-ish' });
    const err = await app.request('/boom');
    expect(err.status).toBe(418);
    expect(await err.json()).toEqual({ error: 'teapot', code: 'error' });
  });

  test('expose.api=false operations are not mounted', async () => {
    expect((await app.request('/hidden')).status).toBe(404);
  });
});

describe('mountOperations options', () => {
  test('middleware runs before input parsing and can short-circuit', async () => {
    const order: string[] = [];
    const guarded = build({
      use: [
        async (c, next) => {
          order.push('mw');
          if (c.req.query('deny')) return c.json({ error: 'not found' }, 404);
          return next();
        },
      ],
    });
    // Invalid input but denied: the guard answers first (404, not 400).
    const denied = await guarded.request('/items/not-a-uuid?deny=1');
    expect(denied.status).toBe(404);
    expect(order).toEqual(['mw']);
    const ok = await guarded.request(`/items/${ID}?scope=${S}`);
    expect(ok.status).toBe(200);
    expect(order).toEqual(['mw', 'mw']);
  });

  test('basePath: registered relative to the prefix the caller mounts under', async () => {
    const itemsOnly = [ops[0]!, ops[1]!];
    const router = mountOperations(new Hono(), itemsOnly, { basePath: '/items' });
    const app = new Hono();
    app.onError(httpOnError);
    app.route('/items', router);
    expect((await app.request(`/items/${ID}?scope=${S}`)).status).toBe(200);
    expect((await app.request('/items', json({ scope: S, name: 'x' }))).status).toBe(201);
    expect(() => mountOperations(new Hono(), itemsOnly, { basePath: '/other' })).toThrow(/not under basePath/);
  });
});

describe('createApiClient', () => {
  const app = build();
  const client = createApiClient({
    baseUrl: 'http://api.test/',
    token: 'tok',
    fetch: (req) => Promise.resolve(app.fetch(req)),
  });

  test('call() routes input to path/query/body per the contract', async () => {
    const got = await client.call(getItem, { id: ID, scope: S, limit: 3 });
    expect(got).toEqual({ ok: true, input: { id: ID, scope: S, limit: 3 } });

    const created = await client.call(createItem, { scope: S, name: 'viaclient', tags: ['a'] });
    expect(created).toEqual({ id: ID, scope: S, name: 'viaclient', tags: ['a'] });

    expect(await client.call(patchItem, { id: ID, scope: S, name: 'p' })).toBeNull();
    expect(seen.patch).toEqual({ id: ID, scope: S, name: 'p' });

    await client.call(deleteItem, { id: ID, scope: S });
    expect(seen.delete).toEqual({ id: ID, scope: S });

    await client.call(setTarget, { id: ID, target: null });
    expect(seen.target).toEqual({ id: ID, target: null });
  });

  test('errors carry the API status and the {error} message', async () => {
    const err = await client.call(boom).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(418);
    expect((err as ApiError).message).toBe('teapot');
    const bad = await client.call(getItem, { id: 'nope', scope: S }).catch((e: unknown) => e);
    expect((bad as ApiError).status).toBe(400);
  });

  test('bearer token is sent; verbs helpers work', async () => {
    let auth: string | null = null;
    const c2 = createApiClient({
      baseUrl: 'http://api.test',
      token: 'secret',
      fetch: (req) => {
        auth = req.headers.get('authorization');
        return Promise.resolve(Response.json({ method: req.method, url: req.url }));
      },
    });
    expect(await c2.put('/x', { a: 1 }, { q: 'v' })).toEqual({ method: 'PUT', url: 'http://api.test/x?q=v' });
    expect(auth as string | null).toBe('Bearer secret');
    expect(((await c2.delete('/y')) as { method: string }).method).toBe('DELETE');
  });

  test('missing path param is a client-side error', () => {
    expect(() => client.call(getItem, { scope: S })).toThrow(/missing path param id/);
  });
});
