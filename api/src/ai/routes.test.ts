/**
 * AI key operations over HTTP, against Postgres and fake providers (the
 * registry test seam): detection/override, save (seal, verify, model check),
 * status, test, model listing, delete and the shared-key fallback. No
 * provider is ever called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts as aiContracts, type AiProviderId } from '@shared/contracts/ai';

import { pool } from '../core/db';
import { describeOperationCatalog } from '../core/operation-catalog-test';
import { configureSecretBox } from '../core/secret-box';
import { dbReady } from '../core/test-gate';
import { makeOpCaller } from '../core/test-op';
import { httpOnError } from '../core/validate';
import type { IdentityUser } from '../user';
import ai, { providerFor } from './index';
import * as aiModule from './index';
import { operations } from './routes';
import { AiProviderError } from './errors';
import { configureAiEnv } from './env';
import { resolveAiKey } from './keys';
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
type Call = { kind: 'verify' | 'list'; provider: AiProviderId; apiKey: string };
let calls: Call[] = [];
let verifyFailure: unknown = null;
let listFailure: unknown = null;
/** When set, the fake key check returns this list (the OpenAI/DeepSeek shape). */
let verifyModels: AiModel[] | null = null;

const fakeEntry = (id: AiProviderId): ProviderEntry => ({
  baseUrl: `https://${id}.test`,
  create: (apiKey: string) => ({
    id,
    chat: async () => {
      throw new Error('chat is not used by the key routes');
    },
    verifyKey: async () => {
      calls.push({ kind: 'verify', provider: id, apiKey });
      if (verifyFailure) throw verifyFailure;
      return verifyModels;
    },
    listModels: async () => {
      calls.push({ kind: 'list', provider: id, apiKey });
      if (listFailure) throw listFailure;
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
  verifyFailure = null;
  listFailure = null;
  verifyModels = null;
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
    expect((await op('ai_provider_detect', { api_key: '0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp' })).json).toEqual({ provider: null });
    expect((await op('ai_provider_detect', { api_key: 'not-a-known-key' })).json).toEqual({ provider: null });
    expect(calls).toEqual([]);
  });

  test('save verifies the key with an authenticated call, checks the model, seals it and returns status', async () => {
    const res = await op('ai_credentials_save', { api_key: KEY, model: 'model-a' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      own: { provider: 'openrouter', model: 'model-a', updated_at: expect.any(String) },
      shared: { available: false, provider: null, model: null },
      effective: 'own',
    });
    expect(JSON.stringify(res.json)).not.toContain(KEY);
    expect(calls).toEqual([
      { kind: 'verify', provider: 'openrouter', apiKey: KEY },
      { kind: 'list', provider: 'openrouter', apiKey: KEY },
    ]);
    const row = await store.getCredential(pool, user.id);
    expect(row).not.toBeNull();
    expect(Buffer.from(row!.secret_ciphertext).toString('utf8')).not.toContain(KEY);
  });

  test('save lets the caller override the detected provider', async () => {
    const res = await op('ai_credentials_save', { api_key: 'custom-key-123456', provider: 'deepseek' });
    expect(res.status).toBe(200);
    expect(res.json.own.provider).toBe('deepseek');
    expect(res.json.own.model).toBeNull();
    expect(calls).toEqual([{ kind: 'verify', provider: 'deepseek', apiKey: 'custom-key-123456' }]);
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
    verifyFailure = new AiProviderError('auth', `openrouter API 401: Incorrect API key provided: ${KEY}`);
    const res = await op('ai_credentials_save', { api_key: KEY });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('ai_key_rejected');
    expect(JSON.stringify(res.json)).not.toContain(KEY);
    expect(calls).toEqual([{ kind: 'verify', provider: 'openrouter', apiKey: KEY }]);
    expect(await store.getCredential(pool, user.id)).toBeNull();
  });

  test('a rate-limited provider is 429 with Retry-After; an outage is 502; provider text stays out', async () => {
    verifyFailure = new AiProviderError('rate_limited', `quota exceeded for org org-secret key ${KEY}`, 429, 7000);
    const limited = await op('ai_credentials_save', { api_key: KEY });
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBe('7');
    const limitedBody = JSON.stringify(limited.json);
    expect(limitedBody).not.toContain('org-secret');
    expect(limitedBody).not.toContain(KEY);

    verifyFailure = new AiProviderError('transient', 'upstream down at secret-host');
    const down = await op('ai_credentials_save', { api_key: KEY });
    expect(down.status).toBe(502);
    expect(down.json.code).toBe('upstream_error');
    expect(JSON.stringify(down.json)).not.toContain('secret-host');
    expect(down.headers.get('retry-after')).toBeNull();
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

  test('test verifies the saved key with an authenticated call and lists its models; no key is 403', async () => {
    expect((await op('ai_credentials_test', {})).json.code).toBe('own_ai_key_required');
    await op('ai_credentials_save', { api_key: KEY });
    calls = [];
    const res = await op('ai_credentials_test', {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ provider: 'openrouter', models: 2 });
    expect(JSON.stringify(res.json)).not.toContain(KEY);
    expect(calls).toEqual([
      { kind: 'verify', provider: 'openrouter', apiKey: KEY },
      { kind: 'list', provider: 'openrouter', apiKey: KEY },
    ]);
  });

  test('test reports a key the provider refuses even when the model list is public', async () => {
    await op('ai_credentials_save', { api_key: KEY });
    calls = [];
    verifyFailure = new AiProviderError('auth', 'Invalid API key');
    const res = await op('ai_credentials_test', {});
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('ai_key_rejected');
    expect(calls).toEqual([{ kind: 'verify', provider: 'openrouter', apiKey: KEY }]);
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
    expect(calls).toEqual([{ kind: 'list', provider: 'openrouter', apiKey: KEY }]);

    await op('ai_credentials_save', { api_key: KEY });
    calls = [];
    const saved = await op('ai_models_list', {});
    expect(saved.json.provider).toBe('openrouter');
    expect(calls).toEqual([{ kind: 'list', provider: 'openrouter', apiKey: KEY }]);

    // A stored key never goes to another provider's host.
    calls = [];
    const overridden = await op('ai_models_list', { provider: 'openai' });
    expect(overridden.status).toBe(400);
    expect(overridden.json.code).toBe('ai_provider_mismatch');
    expect(calls).toEqual([]);

    // An explicit provider on a CANDIDATE key is the caller's own choice.
    calls = [];
    const candidateOverride = await op('ai_models_list', { api_key: KEY, provider: 'openai' });
    expect(candidateOverride.json.provider).toBe('openai');
    expect(calls).toEqual([{ kind: 'list', provider: 'openai', apiKey: KEY }]);
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
    expect(calls).toEqual([
      { kind: 'verify', provider: 'anthropic', apiKey: SHARED_KEY },
      { kind: 'list', provider: 'anthropic', apiKey: SHARED_KEY },
    ]);

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

  test('a shared key with no model is not available and does not resolve', async () => {
    await enableShared();
    await pool.query('delete from public.app_settings where key = $1', [AI_SHARED_MODEL_SETTING]);
    configureAiEnv({ AI_SHARED_API_KEY: SHARED_KEY, AI_SHARED_PROVIDER: 'anthropic' });
    const status = await op('ai_credentials_get', {});
    expect(status.json.shared).toEqual({ available: false, provider: 'anthropic', model: null });
    expect(status.json.effective).toBeNull();
    const res = await op('ai_credentials_test', {});
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('ai_shared_model_missing');
    expect(calls).toEqual([]);
  });

  test('an unreadable provider row shows no source and blocks the shared fallback', async () => {
    await enableShared();
    await store.saveCredential(pool, {
      userId: user.id,
      provider: 'bogus',
      ciphertext: new Uint8Array(16),
      nonce: new Uint8Array(12),
      keyVersion: 1,
      model: null,
    });
    const status = await op('ai_credentials_get', {});
    expect(status.status).toBe(200);
    expect(status.json.own).toBeNull();
    expect(status.json.shared.available).toBe(true);
    expect(status.json.effective).toBeNull();
    expect(await resolveAiKey(pool, user.id)).toEqual({ ok: false, problem: 'unreadable' });
  });

  test('a valid-provider row whose secret no longer opens is not effective own', async () => {
    const sealedBox = { current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) };
    configureSecretBox(sealedBox);
    try {
      expect((await op('ai_credentials_save', { api_key: KEY })).status).toBe(200);
      expect((await op('ai_credentials_get', {})).json.effective).toBe('own');

      // A different master key: the stored ciphertext no longer opens here.
      configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
      const status = await op('ai_credentials_get', {});
      expect(status.json.own.provider).toBe('openrouter');
      expect(status.json.effective).toBeNull();
      expect(await resolveAiKey(pool, user.id)).toEqual({ ok: false, problem: 'unreadable' });
    } finally {
      configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
    }
  });

  test('providerFor builds the adapter for the resolved key; the raw pair is not exported', async () => {
    expect('createProvider' in aiModule).toBe(false);
    await op('ai_credentials_save', { api_key: KEY });
    const resolved = await resolveAiKey(pool, user.id);
    if (!resolved.ok) throw new Error('expected a resolved key');
    calls = [];
    const provider = providerFor(resolved.key);
    expect(provider.id).toBe('openrouter');
    await provider.listModels();
    expect(calls).toEqual([{ kind: 'list', provider: 'openrouter', apiKey: KEY }]);
  });

  test('save and test reuse the models the key check fetched', async () => {
    verifyModels = MODELS;
    const saved = await op('ai_credentials_save', { api_key: KEY, model: 'model-a' });
    expect(saved.status).toBe(200);
    expect(calls).toEqual([{ kind: 'verify', provider: 'openrouter', apiKey: KEY }]);

    calls = [];
    const tested = await op('ai_credentials_test', {});
    expect(tested.json).toEqual({ provider: 'openrouter', models: 2 });
    expect(calls).toEqual([{ kind: 'verify', provider: 'openrouter', apiKey: KEY }]);
  });

  test('a key the provider forbids is 403 ai_key_forbidden, not a bad key', async () => {
    verifyFailure = new AiProviderError('forbidden', 'Missing scopes: api.model.read', 403);
    const save = await op('ai_credentials_save', { api_key: KEY });
    expect(save.status).toBe(403);
    expect(save.json.code).toBe('ai_key_forbidden');
    expect(JSON.stringify(save.json)).not.toContain('api.model.read');

    verifyFailure = null;
    await op('ai_credentials_save', { api_key: KEY });
    calls = [];
    listFailure = new AiProviderError('forbidden', 'Missing scopes: api.model.read', 403);
    const listed = await op('ai_models_list', {});
    expect(listed.status).toBe(403);
    expect(listed.json.code).toBe('ai_key_forbidden');
  });

  test('provider log text is redacted for fragments, masked keys and Z.ai shapes', async () => {
    const zaiKey = '0123456789abcdef0123456789abcdef.SECRETsecret1234';
    const fragment = KEY.slice(4, 16);
    verifyFailure = new AiProviderError(
      'transient',
      `refused ${KEY} fragment ${fragment} masked sk-proj-****abcd other ${zaiKey}`,
    );
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    let logged = '';
    try {
      await op('ai_credentials_save', { api_key: KEY });
      logged = spy.mock.calls.map((call) => call.join(' ')).join(' ');
    } finally {
      spy.mockRestore();
    }
    expect(logged).toContain('[redacted]');
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(fragment);
    expect(logged).not.toContain('****abcd');
    expect(logged).not.toContain(zaiKey);
  });
});
