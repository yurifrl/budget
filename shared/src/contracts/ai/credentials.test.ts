import { describe, expect, test } from 'bun:test';

import type { z } from '../../zod';
import { inputLocations } from '../../operation-contract';
import {
  AI_PROVIDERS,
  aiCredentialStatusSchema,
  aiCredentialsDelete,
  aiCredentialsGet,
  aiCredentialsSave,
  aiCredentialsTest,
  aiModelsList,
  aiProviderDetect,
  aiProviderSchema,
  contracts,
} from './index';

const operations = [aiCredentialsGet, aiCredentialsSave, aiCredentialsDelete, aiCredentialsTest, aiProviderDetect, aiModelsList];

describe('AI key contracts', () => {
  test('six operations in the ai barrel, all API-exposed and none reachable from MCP', () => {
    const names = contracts.map((c) => c.name);
    for (const c of operations) {
      expect(names).toContain(c.name);
      expect(c.path.startsWith('/ai/')).toBe(true);
      expect(c.expose.api).toBe(true);
      expect(c.expose.mcp).toBe(false);
    }
    expect(contracts.length).toBe(6);
  });

  test('user-scoped: no path id and no budget_id anywhere', () => {
    for (const c of operations) {
      const loc = inputLocations(c);
      expect(loc.path).toEqual([]);
      expect(Object.keys(c.input.shape)).not.toContain('budget_id');
      expect(Object.keys(c.input.shape)).not.toContain('id');
    }
  });

  test('nothing that could carry a secret is exposed to the CLI or MCP', () => {
    expect(aiCredentialsSave.expose).toEqual({ api: true, cli: false, mcp: false });
    expect(aiProviderDetect.expose).toEqual({ api: true, cli: false, mcp: false });
    expect(aiModelsList.expose).toEqual({ api: true, cli: false, mcp: false });
    // Status, delete and test carry no key.
    expect(aiCredentialsGet.expose.cli).toBe(true);
    expect(aiCredentialsDelete.expose.cli).toBe(true);
    expect(aiCredentialsTest.expose.cli).toBe(true);
  });

  test('reads are GET; the two key-carrying POSTs put the key in the body, never the query', () => {
    expect(aiCredentialsGet.method).toBe('GET');
    expect(aiCredentialsTest.method).toBe('GET');
    expect(inputLocations(aiCredentialsGet).body).toEqual([]);
    expect(inputLocations(aiCredentialsTest).body).toEqual([]);
    for (const c of [aiProviderDetect, aiModelsList]) {
      expect(c.method).toBe('POST');
      expect(inputLocations(c).query).toEqual([]);
      expect(inputLocations(c).body).toContain('api_key');
    }
  });

  test('the provider list is the closed five', () => {
    expect(AI_PROVIDERS).toEqual(['openrouter', 'anthropic', 'openai', 'zai', 'deepseek']);
    expect(aiProviderSchema.safeParse('kimi').success).toBe(false);
    expect(aiProviderSchema.safeParse('zai').success).toBe(true);
  });

  test('save needs a plausible key; model and provider are optional; strings are trimmed', () => {
    const parsed = aiCredentialsSave.input.parse({ api_key: '  sk-or-v1-abcdefghijklmnop  ' });
    expect(parsed).toEqual({ api_key: 'sk-or-v1-abcdefghijklmnop' });
    expect(aiCredentialsSave.input.safeParse({ api_key: 'short' }).success).toBe(false);
    expect(aiCredentialsSave.input.safeParse({ api_key: 'sk-or-v1-abcdefghijklmnop', provider: 'nope' }).success).toBe(false);
    expect(aiCredentialsSave.input.safeParse({ api_key: 'sk-or-v1-abcdefghijklmnop', model: '  ' }).success).toBe(false);
  });

  test('the status output has no field for the key', () => {
    expect(Object.keys(aiCredentialStatusSchema.shape).sort()).toEqual(['effective', 'own', 'shared']);
    expect(aiCredentialsGet.output).toBe(aiCredentialStatusSchema);
    expect(aiCredentialsSave.output).toBe(aiCredentialStatusSchema);
    const none = { own: null, shared: { available: false, provider: null, model: null }, effective: null };
    expect(aiCredentialStatusSchema.parse(none)).toEqual(none);
    const own: z.infer<typeof aiCredentialStatusSchema> = {
      own: { provider: 'openai', model: 'gpt-4.1-mini', updated_at: '2026-11-24T12:00:00.000Z' },
      shared: { available: true, provider: 'openrouter', model: 'openai/gpt-4.1-mini' },
      effective: 'own',
    };
    expect(aiCredentialStatusSchema.parse(own)).toEqual(own);
  });
});
