/**
 * The AI key form state machine: a new key invalidates the old pair (so a
 * stale list answer can never be used), a retry of the same pair keeps the
 * chosen model, and Save's model is the committed pick or the typed text
 * where the list cannot confirm it. These are the sequences the hook's
 * effects rely on, tested without a renderer.
 */
import { describe, expect, test } from 'bun:test';

import type { AiModel } from '@/budget/data/api';
import {
  aiKeyFormReducer,
  canSaveAiKey,
  effectiveModel,
  initialAiKeyForm,
  isModelListPending,
  modelToken,
  shouldListModels,
  type AiKeyFormEvent,
  type AiKeyFormState,
} from './aiKeyForm.logic';

const MODELS: AiModel[] = [
  { id: 'glm-4.6', name: 'glm-4.6', context_length: null },
  { id: 'gpt-5', name: 'GPT-5', context_length: 400000 },
];

const KEY = 'sk-1234567890';
const TOKEN = `openai\n${KEY}`;

function reduce(...events: AiKeyFormEvent[]): AiKeyFormState {
  return events.reduce(aiKeyFormReducer, initialAiKeyForm());
}

function openAiLoaded(state: AiKeyFormState = reduce()): AiKeyFormState {
  return aiKeyFormReducer(
    aiKeyFormReducer(
      aiKeyFormReducer(
        aiKeyFormReducer(state, { type: 'keyEdited', key: KEY }),
        { type: 'detected', provider: 'openai' },
      ),
      { type: 'modelsStarted', token: TOKEN },
    ),
    { type: 'modelsLoaded', token: TOKEN, models: MODELS },
  );
}

describe('modelToken', () => {
  test('is null without a provider or before the key could be real', () => {
    expect(modelToken(null, KEY)).toBeNull();
    expect(modelToken('openai', 'short')).toBeNull();
    expect(modelToken('openai', `  ${KEY}  `)).toBe(TOKEN);
  });
});

describe('shouldListModels', () => {
  test('waits for a plausible key and settled detection, and never repeats a listed pair', () => {
    expect(shouldListModels(initialAiKeyForm())).toBe(false);
    const short = aiKeyFormReducer(initialAiKeyForm(), { type: 'keyEdited', key: 'short' });
    expect(shouldListModels(short)).toBe(false);
    const noProvider = aiKeyFormReducer(initialAiKeyForm(), { type: 'keyEdited', key: KEY });
    expect(shouldListModels(noProvider)).toBe(false);
    const detecting = aiKeyFormReducer(
      aiKeyFormReducer(noProvider, { type: 'detected', provider: 'openai' }),
      { type: 'detectStarted' },
    );
    expect(shouldListModels(detecting)).toBe(false);
    const ready = aiKeyFormReducer(noProvider, { type: 'detected', provider: 'openai' });
    expect(shouldListModels(ready)).toBe(true);
    const listed = aiKeyFormReducer(
      aiKeyFormReducer(ready, { type: 'modelsStarted', token: TOKEN }),
      { type: 'modelsLoaded', token: TOKEN, models: MODELS },
    );
    expect(shouldListModels(listed)).toBe(false);
  });
});

describe('isModelListPending', () => {
  test('is true until the list answers, loaded or failed', () => {
    expect(isModelListPending({ modelsLoading: false, modelsLoaded: false, modelsError: false })).toBe(true);
    expect(isModelListPending({ modelsLoading: true, modelsLoaded: false, modelsError: false })).toBe(true);
    expect(isModelListPending({ modelsLoading: false, modelsLoaded: true, modelsError: false })).toBe(false);
    expect(isModelListPending({ modelsLoading: false, modelsLoaded: false, modelsError: true })).toBe(false);
  });
});

describe('canSaveAiKey', () => {
  const base = { key: KEY, provider: 'openai' as const, detecting: false, modelsLoading: false, modelsLoaded: false, modelsError: false };

  test('stays disabled from the paste until the list answers', () => {
    expect(canSaveAiKey({ ...base, detecting: true })).toBe(false); // detection running
    expect(isModelListPending(base)).toBe(true);
    expect(canSaveAiKey(base)).toBe(false); // debounce window before modelsStarted
    expect(canSaveAiKey({ ...base, modelsLoading: true })).toBe(false);
    expect(canSaveAiKey({ ...base, modelsLoaded: true })).toBe(true);
    expect(canSaveAiKey({ ...base, modelsError: true })).toBe(true);
  });

  test('also needs a plausible key and a provider', () => {
    expect(canSaveAiKey({ ...base, modelsLoaded: true, key: 'short' })).toBe(false);
    expect(canSaveAiKey({ ...base, modelsLoaded: true, provider: null })).toBe(false);
  });
});

describe('keyEdited', () => {
  test('a new key drops the guessed provider and every list/model state', () => {
    const loaded = openAiLoaded();
    const next = aiKeyFormReducer(loaded, { type: 'keyEdited', key: `${KEY}x` });
    expect(next.key).toBe(`${KEY}x`);
    expect(next.provider).toBeNull();
    expect(next.detected).toBeNull();
    expect(next.models).toEqual([]);
    expect(next.modelsFor).toBeNull();
    expect(next.model).toBeNull();
    expect(next.modelQuery).toBe('');
    expect(next.attemptedToken).toBeNull();
  });

  test('a stale list answer is ignored after the key changed', () => {
    const typing = reduce({ type: 'keyEdited', key: KEY }, { type: 'detected', provider: 'openai' });
    const started = aiKeyFormReducer(typing, { type: 'modelsStarted', token: TOKEN });
    const changed = aiKeyFormReducer(started, { type: 'keyEdited', key: `${KEY}x` });
    const late = aiKeyFormReducer(changed, { type: 'modelsLoaded', token: TOKEN, models: MODELS });
    expect(late).toBe(changed);
  });

  test('a hand-picked provider survives key edits; a guessed one does not', () => {
    const chosen = reduce(
      { type: 'keyEdited', key: KEY },
      { type: 'providerChosen', provider: 'zai' },
      { type: 'keyEdited', key: `${KEY}zz` },
    );
    expect(chosen.provider).toBe('zai');
    const guessed = reduce(
      { type: 'keyEdited', key: KEY },
      { type: 'detected', provider: 'openai' },
      { type: 'keyEdited', key: `${KEY}zz` },
    );
    expect(guessed.provider).toBeNull();
  });

  test('the same trimmed key only updates the raw text', () => {
    const loaded = openAiLoaded();
    const next = aiKeyFormReducer(loaded, { type: 'keyEdited', key: `  ${KEY}` });
    expect(next.models).toBe(loaded.models);
    expect(next.modelsFor).toBe(loaded.modelsFor);
  });
});

describe('detection and provider choice', () => {
  test('detection fills the provider once it settles', () => {
    const started = reduce({ type: 'keyEdited', key: KEY }, { type: 'detectStarted' });
    expect(started.detecting).toBe(true);
    const done = aiKeyFormReducer(started, { type: 'detected', provider: 'anthropic' });
    expect(done.detecting).toBe(false);
    expect(done.provider).toBe('anthropic');
    expect(done.detected).toBe('anthropic');
  });

  test('a manual choice is not overwritten by a later detection', () => {
    const chosen = reduce(
      { type: 'keyEdited', key: KEY },
      { type: 'providerChosen', provider: 'zai' },
      { type: 'detected', provider: 'anthropic' },
    );
    expect(chosen.provider).toBe('zai');
    expect(chosen.detected).toBe('anthropic');
  });
});

describe('the model list', () => {
  test('starts, loads and reports the token in hand', () => {
    const started = aiKeyFormReducer(reduce({ type: 'keyEdited', key: KEY }, { type: 'detected', provider: 'openai' }), {
      type: 'modelsStarted',
      token: TOKEN,
    });
    expect(started.modelsLoading).toBe(true);
    expect(started.attemptedToken).toBe(TOKEN);
    const loaded = aiKeyFormReducer(started, { type: 'modelsLoaded', token: TOKEN, models: MODELS });
    expect(loaded.modelsLoading).toBe(false);
    expect(loaded.models).toEqual(MODELS);
    expect(loaded.modelsFor).toBe(TOKEN);
  });

  test('a retry of the same pair keeps the model; a new pair clears it', () => {
    const loaded = openAiLoaded();
    const picked = aiKeyFormReducer(loaded, { type: 'modelCommitted', id: 'gpt-5' });
    const failed = aiKeyFormReducer(picked, { type: 'modelsFailed', token: TOKEN, message: 'busy', retryable: true });
    const retried = aiKeyFormReducer(failed, { type: 'retryModels' });
    const restarted = aiKeyFormReducer(retried, { type: 'modelsStarted', token: TOKEN });
    expect(restarted.model).toBe('gpt-5');
    expect(restarted.modelQuery).toBe('GPT-5');
    const nextPair = aiKeyFormReducer(restarted, { type: 'modelsStarted', token: `${TOKEN}2` });
    expect(nextPair.model).toBeNull();
    expect(nextPair.modelQuery).toBe('');
  });

  test('a loaded list drops a chosen model it does not contain', () => {
    const picked = aiKeyFormReducer(openAiLoaded(), { type: 'modelCommitted', id: 'gpt-5' });
    const reloaded = aiKeyFormReducer(
      aiKeyFormReducer(picked, { type: 'retryModels' }),
      { type: 'modelsStarted', token: TOKEN },
    );
    const loaded = aiKeyFormReducer(reloaded, {
      type: 'modelsLoaded',
      token: TOKEN,
      models: [{ id: 'glm-4.6', name: 'glm-4.6', context_length: null }],
    });
    expect(loaded.model).toBeNull();
    expect(loaded.modelQuery).toBe('');
  });

  test('editing the search text keeps the chosen model; clearing the field unchoses', () => {
    const picked = aiKeyFormReducer(openAiLoaded(), { type: 'modelCommitted', id: 'gpt-5' });
    expect(aiKeyFormReducer(picked, { type: 'modelQueryEdited', text: 'gpt' }).model).toBe('gpt-5');
    expect(aiKeyFormReducer(picked, { type: 'modelQueryEdited', text: 'gpt-5' }).model).toBe('gpt-5');
    expect(aiKeyFormReducer(picked, { type: 'modelQueryEdited', text: '   ' }).model).toBeNull();
    expect(effectiveModel(aiKeyFormReducer(picked, { type: 'modelQueryEdited', text: 'gpt' }))).toBe('gpt-5');
  });

  test('Z.ai typed text replaces the pick', () => {
    const zai = aiKeyFormReducer(
      reduce({ type: 'keyEdited', key: KEY }, { type: 'providerChosen', provider: 'zai' }),
      { type: 'modelCommitted', id: 'glm-4.6' },
    );
    const edited = aiKeyFormReducer(zai, { type: 'modelQueryEdited', text: 'glm-5.3-custom' });
    expect(edited.model).toBeNull();
    expect(effectiveModel(edited)).toBe('glm-5.3-custom');
  });
});

describe('effectiveModel', () => {
  const typedZai = (text: string) =>
    aiKeyFormReducer(
      reduce({ type: 'keyEdited', key: KEY }, { type: 'providerChosen', provider: 'zai' }),
      { type: 'modelQueryEdited', text },
    );

  test('a committed model always wins', () => {
    const state = aiKeyFormReducer(openAiLoaded(), { type: 'modelCommitted', id: 'gpt-5' });
    expect(effectiveModel(state)).toBe('gpt-5');
  });

  test('Z.ai accepts typed text even with the list loaded', () => {
    expect(effectiveModel(typedZai('glm-5.3-flashx-custom'))).toBe('glm-5.3-flashx-custom');
    expect(effectiveModel(typedZai('   '))).toBeNull();
  });

  test('another provider uses typed text only after a retryable list failure', () => {
    const loaded = openAiLoaded();
    expect(effectiveModel(aiKeyFormReducer(loaded, { type: 'modelQueryEdited', text: 'gpt-5' }))).toBeNull();
    const retryable = aiKeyFormReducer(loaded, {
      type: 'modelsFailed',
      token: TOKEN,
      message: 'busy',
      retryable: true,
    });
    expect(effectiveModel(aiKeyFormReducer(retryable, { type: 'modelQueryEdited', text: 'gpt-5' }))).toBe('gpt-5');
    const definitive = aiKeyFormReducer(loaded, {
      type: 'modelsFailed',
      token: TOKEN,
      message: 'rejected',
      retryable: false,
    });
    expect(effectiveModel(aiKeyFormReducer(definitive, { type: 'modelQueryEdited', text: 'gpt-5' }))).toBeNull();
  });
});

describe('reset', () => {
  test('returns to the initial form', () => {
    const loaded = openAiLoaded();
    expect(aiKeyFormReducer(loaded, { type: 'reset' })).toEqual(initialAiKeyForm());
  });
});
