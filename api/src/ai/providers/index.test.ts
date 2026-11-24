/**
 * The resolved key and the public factory: the secret must not survive
 * serialization or inspection, the public fields are frozen, and caller
 * options never reach the provider table (so a key cannot be redirected).
 */
import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';

import type { AiProvider } from '../types';
import {
  builtinProviders,
  makeResolvedAiKey,
  providerFor,
  setProviders,
  type ProviderOptions,
  type ResolvedAiKey,
} from './index';

const SECRET = 'sk-test-SECRET-0123456789';
const ANTHROPIC_SECRET = 'sk-ant-SECRET-0123456789';

const resolved = (provider: 'openai' | 'anthropic', apiKey: string, model: string) =>
  makeResolvedAiKey({ source: 'own', provider, model, apiKey, updatedAt: null });

const unused: AiProvider = {
  id: 'openai',
  chat: () => Promise.reject(new Error('unused')),
  verifyKey: () => Promise.resolve(null),
  listModels: () => Promise.resolve([]),
};

describe('ResolvedAiKey', () => {
  test('is frozen: provider and model cannot be re-pointed', () => {
    const key = resolved('openai', SECRET, 'gpt-test');
    expect(Object.isFrozen(key)).toBe(true);
    // A direct assignment would be a type error in this module; Reflect.set is
    // the same [[Set]] operation and reports a frozen property as refused.
    expect(Reflect.set(key, 'provider', 'deepseek')).toBe(false);
    expect(Reflect.set(key, 'model', 'other')).toBe(false);
    expect(key.provider).toBe('openai');
    expect(key.model).toBe('gpt-test');
  });

  test('its secret is absent from JSON, util.inspect and Bun.inspect', () => {
    const key = resolved('openai', SECRET, 'gpt-test');
    for (const text of [JSON.stringify(key), inspect(key, { showHidden: true, depth: Infinity }), Bun.inspect(key)]) {
      expect(text).not.toContain(SECRET);
    }
  });
});

describe('providerFor', () => {
  test('never forwards caller options to the provider table', () => {
    let seen: ProviderOptions | undefined;
    setProviders({
      ...builtinProviders,
      openai: {
        baseUrl: 'https://stub.test',
        create: (_apiKey, options) => {
          seen = options;
          return unused;
        },
      },
    });
    try {
      const adapter = (providerFor as unknown as (key: ResolvedAiKey, options: ProviderOptions) => AiProvider)(
        resolved('openai', SECRET, 'gpt-test'),
        { baseUrl: 'https://evil.example' },
      );
      expect(adapter.id).toBe('openai');
      expect(seen).toBeUndefined();
    } finally {
      setProviders(null);
    }
  });

  test('a built adapter hides the key from JSON, util.inspect and Bun.inspect', () => {
    const adapters = [
      [providerFor(resolved('openai', SECRET, 'gpt-test')), SECRET],
      [providerFor(resolved('anthropic', ANTHROPIC_SECRET, 'claude-test')), ANTHROPIC_SECRET],
    ] as const;
    for (const [adapter, secret] of adapters) {
      for (const text of [JSON.stringify(adapter), inspect(adapter, { showHidden: true, depth: Infinity }), Bun.inspect(adapter)]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  test('rejects a structural key', () => {
    expect(() => providerFor({ provider: 'openai', apiKey: SECRET } as never)).toThrow(TypeError);
  });
});
