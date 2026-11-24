/**
 * Rules of the AI key screen: state derivation, the fixed provider table,
 * detection hints, save-time checks, model rows and one message per AI error
 * code. Tests run in English (docs/i18n.md).
 */
import { describe, expect, test } from 'bun:test';

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

import type { AiCredentialStatus } from '@/budget/data/api';
import {
  aiErrorView,
  aiKeysScreenMode,
  checkSaveInput,
  detectionHint,
  modelOptions,
  providerLabel,
  providerOptions,
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

describe('aiKeysScreenMode', () => {
  test('waits, fails, or shows own / shared / neither', () => {
    expect(aiKeysScreenMode({ status: undefined, isError: false })).toBe('loading');
    expect(aiKeysScreenMode({ status: undefined, isError: true })).toBe('failed');
    expect(aiKeysScreenMode({ status: status(own, true), isError: false })).toBe('saved');
    expect(aiKeysScreenMode({ status: status(null, true), isError: false })).toBe('shared');
    expect(aiKeysScreenMode({ status: status(null, false), isError: false })).toBe('empty');
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
  test('requires a plausible key, a provider and a model', () => {
    expect(checkSaveInput({ apiKey: '  short ', provider: 'openai', model: 'gpt' })?.field).toBe('key');
    expect(checkSaveInput({ apiKey: 'sk-1234567890', provider: null, model: 'gpt' })?.field).toBe('form');
    expect(checkSaveInput({ apiKey: 'sk-1234567890', provider: 'openai', model: null })?.field).toBe('model');
    expect(checkSaveInput({ apiKey: '  sk-1234567890  ', provider: 'openai', model: 'gpt-4o-mini' })).toBeNull();
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

describe('aiErrorView', () => {
  const codes = [
    AI_KEY_REJECTED,
    AI_PROVIDER_UNKNOWN,
    AI_PROVIDER_MISMATCH,
    AI_MODEL_UNKNOWN,
    AI_KEY_REQUIRED,
    AI_ENCRYPTION_MISSING,
    AI_KEY_UNREADABLE,
    AI_SHARED_KEY_MISSING,
    AI_SHARED_MODEL_MISSING,
  ];

  test('every AI error code has its own message, never the generic fallback', () => {
    const generic = t('error.generic');
    const messages = codes.map((code) => aiErrorView({ status: 400, code }));
    for (const message of messages) expect(message).not.toBe(generic);
    expect(new Set(messages).size).toBe(codes.length);
  });

  test('a provider 429, an upstream 502 and a dead connection read clearly', () => {
    expect(aiErrorView({ status: 429, code: 'rate_limited' })).toBe(t('error.rateLimited'));
    expect(aiErrorView({ status: 502, code: 'upstream_error' })).toBe(t('error.providerUnavailable'));
    expect(aiErrorView({ status: 'FETCH_ERROR', message: 'Failed to fetch' })).toBe(t('error.unreachable'));
  });

  test('an unknown failure falls back to the generic sentence', () => {
    expect(aiErrorView({ status: 500, code: 'internal' })).toBe(t('error.generic'));
    expect(aiErrorView(null)).toBe(t('error.generic'));
  });
});
