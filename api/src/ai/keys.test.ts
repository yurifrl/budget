/**
 * AI key resolution against Postgres: sealing/opening, own-wins-over-shared,
 * the feature gate, the shared-key env and the shared model setting. The
 * provider layer is not involved here (no HTTP).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { configureSecretBox, SecretBoxUnavailable } from '../core/secret-box';
import { dbReady } from '../core/test-gate';
import type { IdentityUser } from '../user';
import { configureAiEnv } from './env';
import { aiKeyHttpError, openOwnKey, resolveAiKey, sharedAiStatus, sharedAiAllowed, storeOwnKey } from './keys';
import { AI_SHARED_MODEL_SETTING } from './settings';
import * as store from './store';

const KEY = 'sk-test-0123456789abcdef';
const SHARED_KEY = 'sk-or-v1-shared0123456789abcdef';
const users: IdentityUser[] = [];

async function newUser(label: string): Promise<IdentityUser> {
  const user = { id: crypto.randomUUID(), email: `ai-keys-${label}-${crypto.randomUUID()}@ai.test`, role: 'user' } as IdentityUser;
  await pool.query(`insert into public.users (id, email, role) values ($1, $2, 'user')`, [user.id, user.email]);
  users.push(user);
  return user;
}

async function setSharedFeature(userId: string, value: boolean): Promise<void> {
  await pool.query(
    `insert into public.feature_overrides (feature_key, user_id, value) values ('shared-ai-key', $1, $2)
     on conflict (feature_key, user_id) where user_id is not null do update set value = excluded.value`,
    [userId, value],
  );
}

beforeAll(async () => {
  if (!dbReady) return;
  configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
});

beforeEach(async () => {
  if (!dbReady) return;
  configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
  await pool.query(`delete from public.app_settings where key = $1`, [AI_SHARED_MODEL_SETTING]);
  configureAiEnv({});
});

afterAll(async () => {
  if (!dbReady) return;
  configureSecretBox(null);
  configureAiEnv({});
  await pool.query(`delete from public.app_settings where key = $1`, [AI_SHARED_MODEL_SETTING]);
  await pool.query('delete from public.users where id = any($1::uuid[])', [users.map((u) => u.id)]);
});

describe.skipIf(!dbReady)('sealing own keys', () => {
  test('the stored row is ciphertext; opening it returns the key and keeps provider/model', async () => {
    const user = await newUser('seal');
    const row = await storeOwnKey(pool, user.id, 'openai', KEY, 'gpt-4.1-mini');
    expect(row.provider).toBe('openai');
    expect(row.model).toBe('gpt-4.1-mini');
    expect(Buffer.from(row.secret_ciphertext).toString('utf8')).not.toContain(KEY);
    const stored = await store.getCredential(pool, user.id);
    expect(stored).not.toBeNull();
    expect(await openOwnKey(stored!)).toBe(KEY);
  });

  test('saving replaces the row (one key per user) and deleting is idempotent', async () => {
    const user = await newUser('replace');
    await storeOwnKey(pool, user.id, 'openai', KEY, null);
    await storeOwnKey(pool, user.id, 'anthropic', 'sk-ant-test-0123456789', 'claude-x');
    const row = await store.getCredential(pool, user.id);
    expect(row!.provider).toBe('anthropic');
    expect(row!.model).toBe('claude-x');
    expect(await store.deleteCredential(pool, user.id)).toBe(true);
    expect(await store.deleteCredential(pool, user.id)).toBe(false);
    expect(await store.getCredential(pool, user.id)).toBeNull();
  });

  test('a ciphertext copied onto another user does not open (context binds the row)', async () => {
    const alice = await newUser('alice');
    const bob = await newUser('bob');
    const sealed = await storeOwnKey(pool, alice.id, 'openai', KEY, null);
    await store.saveCredential(pool, {
      userId: bob.id,
      provider: sealed.provider,
      ciphertext: new Uint8Array(sealed.secret_ciphertext),
      nonce: new Uint8Array(sealed.secret_nonce),
      keyVersion: sealed.key_version,
      model: null,
    });
    const resolution = await resolveAiKey(pool, bob.id);
    expect(resolution).toEqual({ ok: false, problem: 'unreadable' });
  });

  test('without a master key, sealing fails and an existing row is unreadable', async () => {
    const user = await newUser('nokey');
    await storeOwnKey(pool, user.id, 'openai', KEY, null);
    configureSecretBox(null);
    let thrown: unknown = null;
    try {
      await storeOwnKey(pool, user.id, 'openai', KEY, null);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SecretBoxUnavailable);
    expect(await resolveAiKey(pool, user.id)).toEqual({ ok: false, problem: 'encryption_missing' });
    expect(aiKeyHttpError('encryption_missing').status).toBe(503);
  });
});

describe.skipIf(!dbReady)('key resolution', () => {
  test('own key wins over an available shared key', async () => {
    const user = await newUser('ownwins');
    await setSharedFeature(user.id, true);
    configureAiEnv({ AI_SHARED_API_KEY: SHARED_KEY, AI_SHARED_PROVIDER: 'openrouter', AI_SHARED_MODEL: 'shared/model' });
    const own = await storeOwnKey(pool, user.id, 'openai', KEY, 'gpt-4.1-mini');
    const resolution = await resolveAiKey(pool, user.id);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.key).toMatchObject({ source: 'own', provider: 'openai', model: 'gpt-4.1-mini', apiKey: KEY });
    expect(resolution.key.updatedAt).toBe(own.updated_at.toISOString());
    // Deleting the own key falls back to the shared one, model from app_settings.
    await pool.query(`insert into public.app_settings (key, value) values ($1, $2::jsonb)`, [AI_SHARED_MODEL_SETTING, JSON.stringify('openrouter/auto')]);
    await store.deleteCredential(pool, user.id);
    const shared = await resolveAiKey(pool, user.id);
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(shared.key).toMatchObject({ source: 'shared', provider: 'openrouter', model: 'openrouter/auto', apiKey: SHARED_KEY, updatedAt: null });
  });

  test('the feature gate: no own key and shared off is own_ai_key_required', async () => {
    const user = await newUser('off');
    configureAiEnv({ AI_SHARED_API_KEY: SHARED_KEY, AI_SHARED_PROVIDER: 'openrouter', AI_SHARED_MODEL: 'm' });
    expect(await sharedAiAllowed(pool, user.id)).toBe(false);
    expect(await resolveAiKey(pool, user.id)).toEqual({ ok: false, problem: 'own_key_required' });
    expect(aiKeyHttpError('own_key_required').status).toBe(403);
  });

  test('feature on but no shared key configured is shared_key_missing', async () => {
    const user = await newUser('noshared');
    await setSharedFeature(user.id, true);
    configureAiEnv({});
    expect(await resolveAiKey(pool, user.id)).toEqual({ ok: false, problem: 'shared_key_missing' });
    expect(aiKeyHttpError('shared_key_missing').status).toBe(503);
  });

  test('shared availability needs the feature, a valid key and a chosen model', async () => {
    const user = await newUser('status');
    configureAiEnv({ AI_SHARED_API_KEY: SHARED_KEY, AI_SHARED_PROVIDER: 'openrouter' });
    expect(await sharedAiStatus(pool, user.id)).toEqual({ available: false, provider: null, model: null });
    await setSharedFeature(user.id, true);
    expect(await sharedAiStatus(pool, user.id)).toEqual({ available: false, provider: 'openrouter', model: null });
    await pool.query(`insert into public.app_settings (key, value) values ($1, $2::jsonb)`, [AI_SHARED_MODEL_SETTING, JSON.stringify('model/x')]);
    expect(await sharedAiStatus(pool, user.id)).toEqual({ available: true, provider: 'openrouter', model: 'model/x' });
  });

  test('the shared provider falls back to detection from the key shape', async () => {
    const user = await newUser('detect');
    await setSharedFeature(user.id, true);
    configureAiEnv({ AI_SHARED_API_KEY: SHARED_KEY, AI_SHARED_MODEL: 'openrouter/auto' });
    const resolution = await resolveAiKey(pool, user.id);
    expect(resolution.ok && resolution.key.provider).toBe('openrouter');
  });
});
