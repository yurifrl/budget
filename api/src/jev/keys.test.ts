/**
 * Jev keys, end to end against Postgres with a stubbed Jev call: a saved key
 * is sealed at rest and never handed back; a key Jev refuses is not stored;
 * remove deletes it; and a run resolves the budget OWNER's own key, then the
 * installation's shared key only when the shared-jev-key feature is on.
 *
 * Nothing here reaches OpenRouter: `setJevProbeFetch` swaps the one probe.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { dbReady } from '../core/test-gate';
import { pool } from '../core/db';
import { httpOnError } from '../core/validate';
import { configureSecretBox, secretBoxConfigured, sealSecret } from '../core/secret-box';
import type { IdentityUser } from '../user';
import { configureJevEnv } from './call';
import jevApp from './routes';
import { resolveJevKey, setJevProbeFetch } from './keys';
import * as store from './store';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'sk-or-v1-fedcba9876543210fedcba9876543210';
const MASTER = new Uint8Array(32).fill(7);
const users: IdentityUser[] = [];

/** A stubbed probe: 200 with a usable answer unless told otherwise. */
const acceptAll: typeof fetch = (async () =>
  new Response(
    JSON.stringify({ answers: { category: { type: 'choice', probabilities: { a: 1 } } } }),
    { status: 200 },
  )) as unknown as typeof fetch;

const refuseAll: typeof fetch = (async () =>
  new Response(JSON.stringify({ error: { message: 'no auth' } }), { status: 401 })) as unknown as typeof fetch;

async function newUser(label: string) {
  const user = {
    id: crypto.randomUUID(),
    email: `jev-${label}-${crypto.randomUUID()}@jevkeys.test`,
    role: 'user',
  } as IdentityUser;
  await pool.query(
    `insert into public.users (id, google_sub, email, role, status) values ($1, null, $2, 'user', 'active')`,
    [user.id, user.email],
  );
  users.push(user);
  const app = new Hono();
  app.onError(httpOnError);
  app.use('*', (c, next) => {
    c.set('user' as never, user as never);
    return next();
  });
  app.route('/jev', jevApp);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/jev${path}`, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    // A test response body: the JSON object the API sent ({} when it sent none).
    const json = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    return { status: res.status, text, json };
  };
  return { user, call };
}

/** The admin's switch over the shared key, as the features store writes it. */
async function setSharedKey(userId: string, value: boolean | null): Promise<void> {
  await pool.query(`delete from public.feature_overrides where feature_key = 'shared-jev-key' and user_id = $1`, [userId]);
  if (value !== null) {
    await pool.query(
      `insert into public.feature_overrides (feature_key, user_id, value) values ('shared-jev-key', $1, $2)`,
      [userId, value],
    );
  }
}

/** Every table's text, to prove a stored key never sits in the clear. */
async function keyAppearsInPlaintext(key: string): Promise<boolean> {
  const hit = await pool.query(
    `select 1 from public.jev_keys x where strpos(x::text, $1) > 0 limit 1`,
    [key],
  );
  return (hit.rowCount ?? 0) > 0;
}

beforeAll(() => {
  configureSecretBox({ current: 1, keys: new Map([[1, MASTER]]) });
});

afterAll(async () => {
  if (!dbReady) return;
  setJevProbeFetch(null);
  configureSecretBox(null);
  await pool.query(`delete from public.feature_overrides where feature_key = 'shared-jev-key'`);
  if (users.length > 0) await pool.query('delete from public.users where id = any($1::uuid[])', [users.map((u) => u.id)]);
});

beforeEach(() => {
  setJevProbeFetch(acceptAll);
  configureJevEnv({});
  configureSecretBox({ current: 1, keys: new Map([[1, MASTER]]) });
});

describe.skipIf(!dbReady)('the caller’s own Jev key', () => {
  test('saving seals the key: stored as ciphertext, and no endpoint ever returns it', async () => {
    const { user, call } = await newUser('sealed');

    const saved = await call('PUT', '/key', { key: KEY });
    expect(saved.status).toBe(200);
    expect(saved.json).toEqual({
      last_four: KEY.slice(-4),
      saved_at: expect.any(String),
      using_server_key: false,
      reason: null,
    });
    expect(saved.text).not.toContain(KEY);

    const row = await store.getJevKey(pool, user.id);
    expect(row).not.toBeNull();
    expect(row!.key_ciphertext.toString()).not.toContain('sk-or');
    expect(await keyAppearsInPlaintext(KEY)).toBe(false);

    for (const [method, path, body] of [
      ['GET', '/key', undefined],
      ['POST', '/key/test', undefined],
      ['PUT', '/key', { key: OTHER_KEY }],
    ] as const) {
      const res = await call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(200);
      expect(res.text, `${method} ${path}`).not.toContain(KEY);
      expect(res.text, `${method} ${path}`).not.toContain(OTHER_KEY);
    }
  });

  test('a key Jev refuses is stored by nobody', async () => {
    const { user, call } = await newUser('refused');
    setJevProbeFetch(refuseAll);

    const res = await call('PUT', '/key', { key: KEY });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('jev_key_rejected');
    expect(await store.getJevKey(pool, user.id)).toBeNull();
  });

  test('when Jev cannot be reached the key is not stored either', async () => {
    const { user, call } = await newUser('unreachable');
    setJevProbeFetch((async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);

    const res = await call('PUT', '/key', { key: KEY });
    expect(res.status).toBe(502);
    expect(res.json.code).toBe('jev_unavailable');
    expect(await store.getJevKey(pool, user.id)).toBeNull();
  });

  test('remove deletes the key and repeats cleanly', async () => {
    const { user, call } = await newUser('remove');
    await call('PUT', '/key', { key: KEY });
    expect(await store.getJevKey(pool, user.id)).not.toBeNull();

    const gone = await call('DELETE', '/key');
    expect(gone.status).toBe(200);
    expect(gone.json).toEqual({ ok: true });
    expect(await store.getJevKey(pool, user.id)).toBeNull();
    expect((await call('DELETE', '/key')).status).toBe(200);
  });

  test('testing with no saved key is a validation error, not a call', async () => {
    const { call } = await newUser('none');
    const res = await call('POST', '/key/test');
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('jev_key_missing');
  });

  test('a missing encryption key is a 503 on save, never plaintext storage', async () => {
    const { user, call } = await newUser('nobox');
    configureSecretBox(null);
    expect(secretBoxConfigured()).toBe(false);

    const res = await call('PUT', '/key', { key: KEY });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('credentials_key_missing');
    expect(await store.getJevKey(pool, user.id)).toBeNull();
  });
});

describe.skipIf(!dbReady)('resolving the key a run uses', () => {
  test('own key first, whatever the feature says', async () => {
    const { user } = await newUser('own');
    await setSharedKey(user.id, true);
    configureJevEnv({ JEV_API_KEY: 'sk-or-v1-sharedsharedshared' });
    await sealSecret(KEY, JSON.stringify(['jev_keys', user.id])).then((sealed) =>
      store.saveJevKey(pool, user.id, sealed, KEY.slice(-4)),
    );

    expect(await resolveJevKey(pool, user.id)).toEqual({ ok: true, key: KEY, source: 'own' });
  });

  test('the shared key only with the shared-jev-key feature on', async () => {
    const { user } = await newUser('shared');
    configureJevEnv({ JEV_API_KEY: 'sk-or-v1-sharedsharedshared' });

    expect(await resolveJevKey(pool, user.id)).toEqual({ ok: false, problem: 'flag_off' });

    await setSharedKey(user.id, true);
    expect(await resolveJevKey(pool, user.id)).toEqual({
      ok: true,
      key: 'sk-or-v1-sharedsharedshared',
      source: 'shared',
    });
  });

  test('flag on but no server key is its own reason', async () => {
    const { user } = await newUser('nokey');
    await setSharedKey(user.id, true);
    configureJevEnv({});

    expect(await resolveJevKey(pool, user.id)).toEqual({ ok: false, problem: 'server_key_missing' });
  });

  test('a stored key that cannot be opened is unreadable, never a guess', async () => {
    const { user } = await newUser('unreadable');
    await sealSecret(KEY, JSON.stringify(['jev_keys', user.id])).then((sealed) =>
      store.saveJevKey(pool, user.id, sealed, KEY.slice(-4)),
    );
    // A different master key models CREDENTIALS_ENCRYPTION_KEY having changed.
    configureSecretBox({ current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) });

    expect(await resolveJevKey(pool, user.id)).toEqual({ ok: false, problem: 'key_unreadable' });
  });
});
