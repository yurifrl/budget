/**
 * AI key operations over HTTP, against Postgres and fake providers (the
 * registry test seam): detection/override, save (seal, verify, model check),
 * status, test, model listing, delete and the shared-key fallback. No
 * provider is ever called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts as aiContracts, type AiProviderId } from '@shared/contracts/ai';

import { pool } from '../core/db';
import { describeOperationCatalog } from '../core/operation-catalog-test';
import { configureSecretBox } from '../core/secret-box';
import { dbReady } from '../core/test-gate';
import { makeOpCaller } from '../core/test-op';
import { httpOnError } from '../core/validate';
import type { IdentityUser } from '../user';
import ai from './index';
import { operations } from './routes';
import { AiProviderError } from './errors';
import { configureAiEnv } from './env';
import { setProviders, type ProviderEntry } from './providers';
import { AI_SHARED_MODEL_SETTING } from './settings';
import * as store from './store';
import type { AiModel } from './types';

describeOperationCatalog('ai', operations, ai, '/ai');

const user: IdentityUser = {
  id: crypto.randomUUID(),
  email: `ai-routes-${crypto.randomUUID()}@ai.test`,
  googleSub: null,
  role: 'user',
  status: 'active',
};
let acting: IdentityUser = user;
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user' as never, acting as never);
  return next();
});
app.route('/ai', ai);
const op = makeOpCaller(app, aiContracts);

const MODELS: AiModel[] = [
  { id: 'model-a', name: 'Model A', contextLength: 128_000 },
  { id: 'model-b', name: 'Model B', contextLength: null },
];
type Call = { provider: AiProviderId; apiKey: string };
let calls: Call[] = [];
let failure: unknown = null;

const fakeEntry = (id: AiProviderId): ProviderEntry => ({
  baseUrl: `https://${id}.test`,
  create: (apiKey: string) => ({
    id,
    chat: async () => {
      throw new Error('chat is not used by the key routes');
    },
    listModels: async () => {
      calls.push({ provider: id, apiKey });
      if (failure) throw failure;
      return MODELS;
    },
  }),
});

const fakeTable: Record<AiProviderId, ProviderEntry> = {
  openrouter: fakeEntry('openrouter'),
  anthropic: fakeEntry('anthropic'),
  openai: fakeEntry('openai'),
  zai: fakeEntry('zai'),
  deepseek: fakeEntry('deepseek'),
};

const KEY = 'sk-or-v1-routetest0123456789abcdef';
const SHARED_KEY = 'sk-ant-shared0123456789abcdef';
const SHARED_MODEL = 'shared-model';

beforeAll(async () => {
  if (!dbReady) return;
  configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
  setProviders(fakeTable);
  await pool.query(`insert into public.users (id, email, role) values ($1, $2, 'user')`, [user.id, user.email]);
});

beforeEach(async () => {
  if (!dbReady) return;
  calls = [];
  failure = null;
  acting = user;
  await store.deleteCredential(pool, user.id);
  await pool.query(`delete from public.feature_overrides where feature_key = 'shared-ai-key' and user_id = $1`, [user.id]);
  await pool.query(`delete from public.app_settings where key = $1`, [AI_SHARED_MODEL_SETTING]);
  configureAiEnv({});
});

afterAll(async () => {
  if (!dbReady) return;
  setProviders(null);
  configureSecretBox(null);
  configureAiEnv({});
  await pool.query(`delete from public.app_settings where key = $1`, [AI_SHARED_MODEL_SETTING]);
  await pool.query(`delete from public.feature_overrides where feature_key = 'shared-ai-key' and user_id = $1`, [user.id]);
  await pool.query('delete from public.users where id = $1', [user.id]);
});

async function enableShared(): Promise<void> {
  await pool.query(
    `insert into public.feature_overrides (feature_key, user_id, value) values ('shared-ai-key', $1, true)
     on conflict (feature_key, user_id) where user_id is not null do update set value = true`,
    [user.id],
  );
  await pool.query(`insert into public.app_settings (key, value) values ($1, $2::jsonb)`, [
    AI_SHARED_MODEL_SETTING,
    JSON.stringify(SHARED_MODEL),
  ]);
  configureAiEnv({ AI_SHARED_API_KEY: SHARED_KEY, AI_SHARED_PROVIDER: 'anthropic' });
}

describe.skipIf(!dbReady)('AI key operations', () => {
  test('status with no key: no own, no shared, effective null', async () => {
    const res = await op('ai_credentials_get', {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ own: null, shared: { available: false, provider: null, model: null }, effective: null });
  });

  test('provider detection is local and may answer null', async () => {
    expect((await op('ai_provider_detect', { api_key: KEY })).json).toEqual({ provider: 'openrouter' });
    expect((await op('ai_provider_detect', { api_key: '1234567890.abcdefghijklmnop' })).json).toEqual({ provider: 'zai' });
    expect((await op('ai_provider_detect', { api_key: 'not-a-known-key' })).json).toEqual({ provider: null });
    expect(calls).toEqual([]);
  });

  test('save detects the provider, checks the key by listing models, seals it and returns status', async () => {
    const res = await op('ai_credentials_save', { api_key: KEY, model: 'model-a' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      own: { provider: 'openrouter', model: 'model-a', updated_at: expect.any(String) },
      shared: { available: false, provider: null, model: null },
      effective: 'own',
    });
    expect(JSON.stringify(res.json)).not.toContain(KEY);
    expect(calls).toEqual([{ provider: 'openrouter', apiKey: KEY }]);
    const row = await store.getCredential(pool, user.id);
    expect(row).not.toBeNull();
    expect(Buffer.from(row!.secret_ciphertext).toString('utf8')).not.toContain(KEY);
  });

  test('save lets the caller override the detected provider', async () => {
    const res = await op('ai_credentials_save', { api_key: 'custom-key-123456', provider: 'deepseek' });
    expect(res.status).toBe(200);
    expect(res.json.own.provider).toBe('deepseek');
    expect(res.json.own.model).toBeNull();
    expect(calls[0]!.provider).toBe('deepseek');
  });

  test('save without a detectable provider is 400 ai_provider_unknown', async () => {
    const res = await op('ai_credentials_save', { api_key: 'custom-key-123456' });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('ai_provider_unknown');
    expect(await store.getCredential(pool, user.id)).toBeNull();
  });

  test('save with a model the provider does not list is 400 ai_model_unknown', async () => {
    const res = await op('ai_credentials_save', { api_key: KEY, model: 'nope' });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('ai_model_unknown');
    expect(await store.getCredential(pool, user.id)).toBeNull();
  });

  test('a provider that refuses the key is 400 ai_key_rejected and stores nothing', async () => {
    failure = new AiProviderError('auth', 'openrouter API 401: no');
    const res = await op('ai_credentials_save', { api_key: KEY });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('ai_key_rejected');
    expect(await store.getCredential(pool, user.id)).toBeNull();
  });

  test('a rate-limited provider is 429 and an outage is 502', async () => {
    failure = new AiProviderError('rate_limited', 'slow down', 429, 1000);
    const limited = await op('ai_credentials_save', { api_key: KEY });
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe('rate_limited');

    failure = new AiProviderError('transient', 'upstream down');
    const down = await op('ai_credentials_save', { api_key: KEY });
    expect(down.status).toBe(502);
    expect(down.json.code).toBe('upstream_error');
  });

  test('save without an encryption key is 503 ai_key_encryption_missing, before any provider call', async () => {
    configureSecretBox(null);
    try {
      const res = await op('ai_credentials_save', { api_key: KEY });
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('ai_key_encryption_missing');
      expect(calls).toEqual([]);
    } finally {
      configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
    }
  });

  test('test checks the saved key by listing models; no key is 403', async () => {
    expect((await op('ai_credentials_test', {})).json.code).toBe('own_ai_key_required');
    await op('ai_credentials_save', { api_key: KEY });
    const res = await op('ai_credentials_test', {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ provider: 'openrouter', models: 2 });
    expect(JSON.stringify(res.json)).not.toContain(KEY);
  });

  test('models: a candidate key is listed before saving; without a key the saved one is used', async () => {
    const candidate = await op('ai_models_list', { api_key: KEY });
    expect(candidate.status).toBe(200);
    expect(candidate.json).toEqual({
      provider: 'openrouter',
      models: [
        { id: 'model-a', name: 'Model A', context_length: 128_000 },
        { id: 'model-b', name: 'Model B', context_length: null },
      ],
    });
    expect(JSON.stringify(candidate.json)).not.toContain(KEY);

    await op('ai_credentials_save', { api_key: KEY });
    calls = [];
    const saved = await op('ai_models_list', {});
    expect(saved.json.provider).toBe('openrouter');
    expect(calls).toEqual([{ provider: 'openrouter', apiKey: KEY }]);

    calls = [];
    const overridden = await op('ai_models_list', { provider: 'openai' });
    expect(overridden.json.provider).toBe('openai');
    expect(calls).toEqual([{ provider: 'openai', apiKey: KEY }]);
  });

  test('models with an undetectable candidate key is 400 ai_provider_unknown', async () => {
    const res = await op('ai_models_list', { api_key: 'not-a-known-key' });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('ai_provider_unknown');
  });

  test('delete is idempotent', async () => {
    await op('ai_credentials_save', { api_key: KEY });
    expect((await op('ai_credentials_delete', {})).json).toEqual({ deleted: true });
    expect((await op('ai_credentials_delete', {})).json).toEqual({ deleted: false });
  });

  test('shared key: status and test use it, then an own key wins again', async () => {
    await enableShared();
    const sharedStatus = await op('ai_credentials_get', {});
    expect(sharedStatus.json).toEqual({
      own: null,
      shared: { available: true, provider: 'anthropic', model: SHARED_MODEL },
      effective: 'shared',
    });
    const tested = await op('ai_credentials_test', {});
    expect(tested.json).toEqual({ provider: 'anthropic', models: 2 });
    expect(calls[0]).toEqual({ provider: 'anthropic', apiKey: SHARED_KEY });

    await op('ai_credentials_save', { api_key: KEY });
    expect((await op('ai_credentials_get', {})).json.effective).toBe('own');
  });

  test('feature off, no own key: test is 403; feature on without a server key: 503', async () => {
    expect((await op('ai_credentials_test', {})).json.code).toBe('own_ai_key_required');
    await pool.query(
      `insert into public.feature_overrides (feature_key, user_id, value) values ('shared-ai-key', $1, true)
       on conflict (feature_key, user_id) where user_id is not null do update set value = true`,
      [user.id],
    );
    const res = await op('ai_credentials_test', {});
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('ai_shared_key_missing');
  });
});
