/**
 * Rules of the AI key screen: state derivation, the fixed provider table,
 * detection hints, save-time checks, model rows, the error-code message map,
 * the model-list failure classification and the one-at-a-time credential
 * action. Tests run in English unless they switch locale (docs/i18n.md).
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  AI_ENCRYPTION_MISSING,
  AI_KEY_REJECTED,
  AI_KEY_REQUIRED,
  AI_KEY_UNREADABLE,
  AI_MODEL_UNKNOWN,
  AI_PROVIDER_MISMATCH,
  AI_PROVIDER_UNKNOWN,
  AI_SHARED_KEY_MISSING,
  AI_SHARED_MODEL_MISSING,
} from '@shared/contracts/ai';
import { setLocale } from '@shared/i18n';

import type { AiCredentialStatus } from '@/budget/data/api';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import {
  aiErrorKey,
  aiErrorView,
  aiKeysScreenMode,
  checkSaveInput,
  detectionHint,
  modelListFailure,
  modelOptions,
  ownKeyUnreadable,
  providerLabel,
  providerOptions,
  runCredentialAction,
  type AiErrorKey,
} from './aiKeys.logic';
import { t } from './i18n';

function status(own: AiCredentialStatus['own'], sharedAvailable: boolean): AiCredentialStatus {
  return {
    own,
    shared: {
      available: sharedAvailable,
      provider: sharedAvailable ? 'openrouter' : null,
      model: sharedAvailable ? 'openai/gpt-4o-mini' : null,
    },
    effective: own ? 'own' : sharedAvailable ? 'shared' : null,
  };
}

const own = { provider: 'anthropic' as const, model: 'claude-sonnet-4', updated_at: '2026-11-24T10:00:00.000Z' };

function rawStatus(overrides: Partial<AiCredentialStatus>): AiCredentialStatus {
  return {
    own: null,
    shared: { available: false, provider: null, model: null },
    effective: null,
    ...overrides,
  };
}

describe('aiKeysScreenMode', () => {
  test('waits, fails, or shows own / shared / neither', () => {
    expect(aiKeysScreenMode({ status: undefined, isError: false })).toBe('loading');
    expect(aiKeysScreenMode({ status: undefined, isError: true })).toBe('failed');
    expect(aiKeysScreenMode({ status: status(own, true), isError: false })).toBe('saved');
    expect(aiKeysScreenMode({ status: status(null, true), isError: false })).toBe('shared');
    expect(aiKeysScreenMode({ status: status(null, false), isError: false })).toBe('empty');
  });

  test('a shared provider with available false is not offered as shared AI', () => {
    const shared = { available: false, provider: 'openrouter' as const, model: 'openai/gpt-4o-mini' };
    expect(aiKeysScreenMode({ status: rawStatus({ shared }), isError: false })).toBe('empty');
  });

  test('a stored row the server cannot use blocks the shared fallback', () => {
    // own null + effective null + shared available: an unknown-provider row.
    const shared = { available: true, provider: 'openrouter' as const, model: 'openai/gpt-4o-mini' };
    expect(aiKeysScreenMode({ status: rawStatus({ shared, effective: null }), isError: false })).toBe('blocked');
    // The same shape with effective 'shared' is real shared AI.
    expect(aiKeysScreenMode({ status: rawStatus({ shared, effective: 'shared' }), isError: false })).toBe('shared');
  });
});

describe('ownKeyUnreadable', () => {
  test('an own key the server cannot open is not the key in use', () => {
    // Reachable once budget-ucyr's ownKeyUsable lands: main answers 'own' for
    // any own row. The screen is written ahead of it on purpose.
    expect(ownKeyUnreadable(status(own, false))).toBe(false);
    expect(ownKeyUnreadable(rawStatus({ own, effective: null }))).toBe(true);
    expect(ownKeyUnreadable(status(null, true))).toBe(false);
  });
});

describe('the provider table', () => {
  test('lists the five providers in a stable order, brands untranslated', () => {
    const options = providerOptions();
    expect(options.map((o) => o.id)).toEqual(['openrouter', 'anthropic', 'openai', 'zai', 'deepseek']);
    expect(options.map((o) => o.label)).toEqual(['OpenRouter', 'Anthropic', 'OpenAI', 'Z.ai', 'DeepSeek']);
    expect(providerLabel('zai')).toBe('Z.ai');
  });
});

describe('detectionHint', () => {
  const base = { keyLength: 40, detecting: false, provider: null, detected: null } as const;

  test('says nothing until the text can be a key', () => {
    expect(detectionHint({ ...base, keyLength: 3 })).toBeNull();
  });

  test('shows progress, then the detected provider', () => {
    expect(detectionHint({ ...base, detecting: true })).toBe(t('form.detecting'));
    expect(detectionHint({ ...base, provider: 'openrouter', detected: 'openrouter' })).toBe(
      t('form.detected', { provider: 'OpenRouter' }),
    );
  });

  test('an unknown shape asks the user to choose instead of failing', () => {
    expect(detectionHint(base)).toBe(t('form.providerUnknown'));
  });

  test('a manual choice survives a different detection, and a guess shows without detection', () => {
    expect(detectionHint({ ...base, provider: 'zai', detected: 'anthropic' })).toBe(
      t('form.providerDiffers', { detected: 'Anthropic', chosen: 'Z.ai' }),
    );
    expect(detectionHint({ ...base, provider: 'zai' })).toBe(t('form.providerChosen'));
  });
});

describe('checkSaveInput', () => {
  test('requires a plausible key and a provider; the model is optional', () => {
    expect(checkSaveInput({ apiKey: '  short ', provider: 'openai' })?.field).toBe('key');
    expect(checkSaveInput({ apiKey: 'sk-1234567890', provider: null })?.field).toBe('form');
    expect(checkSaveInput({ apiKey: '  sk-1234567890  ', provider: 'openai' })).toBeNull();
  });
});

describe('modelOptions', () => {
  test('shows the provider name and the id as the sub-line only when it differs', () => {
    expect(
      modelOptions([
        { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini', context_length: 128000 },
        { id: 'bare-id', name: 'bare-id', context_length: null },
        { id: 'empty-name', name: '', context_length: null },
      ]),
    ).toEqual([
      { key: 'openai/gpt-4o-mini', label: 'OpenAI: GPT-4o mini', sub: 'openai/gpt-4o-mini' },
      { key: 'bare-id', label: 'bare-id' },
      { key: 'empty-name', label: 'empty-name' },
    ]);
  });
});

describe('error codes', () => {
  // The exact wire code → catalog key mapping. A swapped entry fails here.
  const expected: Record<string, AiErrorKey> = {
    [AI_KEY_REJECTED]: 'error.keyRejected',
    [AI_PROVIDER_UNKNOWN]: 'error.providerUnknown',
    [AI_PROVIDER_MISMATCH]: 'error.providerMismatch',
    [AI_MODEL_UNKNOWN]: 'error.modelUnknown',
    [AI_KEY_REQUIRED]: 'error.keyRequired',
    [AI_ENCRYPTION_MISSING]: 'error.encryptionMissing',
    [AI_KEY_UNREADABLE]: 'error.keyUnreadable',
    [AI_SHARED_KEY_MISSING]: 'error.sharedKeyMissing',
    [AI_SHARED_MODEL_MISSING]: 'error.sharedModelMissing',
    rate_limited: 'error.rateLimited',
    upstream_error: 'error.providerUnavailable',
  };

  test('every required code maps to its own message key', () => {
    for (const [code, key] of Object.entries(expected)) expect(aiErrorKey(code)).toBe(key);
    expect(aiErrorKey(undefined)).toBeUndefined();
    expect(aiErrorKey('some_other_code')).toBeUndefined();
  });

  test('the message is the key translated, and follows the code, not the HTTP status', () => {
    for (const [code, key] of Object.entries(expected)) {
      expect(aiErrorView({ status: 418, code })).toBe(t(key));
    }
    // A bare 429/502 is not guessed from the status.
    expect(aiErrorView({ status: 429, message: 'HTTP 429' })).toBe(t('error.generic'));
    expect(aiErrorView({ status: 502, message: 'HTTP 502' })).toBe(t('error.generic'));
  });

  test('codes outside the AI set go through apiErrorMessage, never raw server text', () => {
    const invalid = { status: 400, code: 'invalid_input', message: 'api_key is invalid' };
    expect(aiErrorView(invalid)).toBe(apiErrorMessage(invalid, t('error.generic')));
    expect(aiErrorView(invalid)).not.toContain('api_key is invalid');
    const timeout = { status: 504, code: 'upstream_timeout', message: 'The upstream timed out' };
    expect(aiErrorView(timeout)).toBe(apiErrorMessage(timeout, t('error.generic')));
    expect(aiErrorView({ status: 'FETCH_ERROR', message: 'Failed to fetch' })).toBe(
      apiErrorMessage({ status: 'FETCH_ERROR', message: 'Failed to fetch' }, t('error.generic')),
    );
  });

  test('pt-BR has its own message, not the English one', () => {
    const english = aiErrorView({ code: AI_KEY_REJECTED });
    setLocale('pt-BR');
    try {
      const portuguese = aiErrorView({ code: AI_KEY_REJECTED });
      expect(portuguese).toBe(t.for('pt-BR')('error.keyRejected'));
      expect(portuguese).not.toBe(english);
    } finally {
      setLocale('en');
    }
  });
});

afterEach(() => setLocale('en'));

describe('modelListFailure', () => {
  test('retries only rate limits, upstream failures and a dead connection', () => {
    expect(modelListFailure({ status: 429, code: 'rate_limited' })).toEqual({
      message: t('error.rateLimited'),
      retryable: true,
    });
    expect(modelListFailure({ status: 502, code: 'upstream_error' }).retryable).toBe(true);
    expect(modelListFailure({ status: 'FETCH_ERROR', message: 'Failed to fetch' }).retryable).toBe(true);
    expect(modelListFailure({ status: 400, code: AI_KEY_REJECTED }).retryable).toBe(false);
    expect(modelListFailure({ status: 400, code: AI_PROVIDER_UNKNOWN }).retryable).toBe(false);
  });
});

describe('runCredentialAction', () => {
  test('runs once at a time and clears the mutation args when it settles', async () => {
    const pending = Promise.withResolvers<string>();
    const inFlight = { current: false };
    // A minimal stand-in for the RTK mutation: args live in the store, reset drops them.
    const store: { args: { apiKey: string } | null } = { args: { apiKey: 'secret-key' } };
    const reset = () => {
      store.args = null;
    };
    const run = () => ({ unwrap: () => pending.promise });
    const first = runCredentialAction(inFlight, run, reset);
    expect(inFlight.current).toBe(true);
    const second = await runCredentialAction(inFlight, run, reset);
    expect(second).toEqual({ ran: false });
    pending.resolve('saved');
    expect(await first).toEqual({ ran: true, ok: true, value: 'saved' });
    expect(inFlight.current).toBe(false);
    expect(store.args).toBeNull();
  });

  test('reports the failure and still resets (and unlocks)', async () => {
    const inFlight = { current: false };
    let resets = 0;
    const result = await runCredentialAction(
      inFlight,
      () => ({ unwrap: () => Promise.reject(new Error('nope')) }),
      () => {
        resets++;
      },
    );
    expect(result.ran).toBe(true);
    expect(result.ran && result.ok).toBe(false);
    expect(resets).toBe(1);
    expect(inFlight.current).toBe(false);
  });
});
