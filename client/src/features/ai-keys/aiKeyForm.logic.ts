/**
 * Pure state machine of the AI key entry form: the typed key, detection's
 * result, the provider choice, the model list and the model text. The hook
 * only runs effects and mutations against it; every sequence (typing that
 * resets a stale list, a retry keeping the chosen model, a search that keeps
 * the pick, a stale list answer) is decided here and tested in
 * aiKeyForm.logic.test.ts.
 */

import type { AiProviderId } from '@shared/contracts/ai';

import type { AiModel } from '@/budget/data/api';
import { MIN_AI_KEY_LENGTH } from './aiKeys.logic';

/** A failed model-list request as the form needs it (message plus whether retrying can help). */
export interface AiKeyModelsError {
  message: string;
  /** False for a definitive rejection: no Retry, no typed model, no saving without one. */
  retryable: boolean;
}

export interface AiKeyFormState {
  /** Exactly what was typed/pasted; effects trim it. */
  key: string;
  provider: AiProviderId | null;
  /** The user picked the provider by hand: detection must not overwrite it. */
  providerChosen: boolean;
  detected: AiProviderId | null;
  detecting: boolean;
  models: AiModel[];
  /** `${provider}\n${key}` whose list is in hand; null = not loaded for this pair. */
  modelsFor: string | null;
  modelsLoading: boolean;
  modelsError: AiKeyModelsError | null;
  /** The committed model id (a suggestion row or a typed id the user confirmed). */
  model: string | null;
  /** The text in the picker / manual field. */
  modelQuery: string;
  /** Token of the last list attempt: a retry of the same pair keeps the model. */
  attemptedToken: string | null;
}

export type AiKeyFormEvent =
  | { type: 'keyEdited'; key: string }
  | { type: 'detectStarted' }
  | { type: 'detected'; provider: AiProviderId | null }
  | { type: 'providerChosen'; provider: AiProviderId }
  | { type: 'modelsStarted'; token: string }
  | { type: 'modelsLoaded'; token: string; models: AiModel[] }
  | { type: 'modelsFailed'; token: string; message: string; retryable: boolean }
  | { type: 'modelQueryEdited'; text: string }
  | { type: 'modelCommitted'; id: string }
  | { type: 'retryModels' }
  | { type: 'reset' };

export function initialAiKeyForm(): AiKeyFormState {
  return {
    key: '',
    provider: null,
    providerChosen: false,
    detected: null,
    detecting: false,
    models: [],
    modelsFor: null,
    modelsLoading: false,
    modelsError: null,
    model: null,
    modelQuery: '',
    attemptedToken: null,
  };
}

/** The list/report token of a key+provider pair, when the key could be a real one. */
export function modelToken(provider: AiProviderId | null, key: string): string | null {
  const trimmed = key.trim();
  return provider !== null && trimmed.length >= MIN_AI_KEY_LENGTH ? `${provider}\n${trimmed}` : null;
}

/**
 * The model Save uses. A committed pick wins; otherwise typed text counts only
 * where the list cannot vouch for it — Z.ai (its list is a suggestion and the
 * API accepts any id) or a retryable list failure (the manual field).
 */
export function effectiveModel(state: AiKeyFormState): string | null {
  if (state.model !== null) return state.model;
  const typed = state.modelQuery.trim();
  if (typed === '') return null;
  if (state.provider === 'zai' || (state.modelsError !== null && state.modelsError.retryable)) return typed;
  return null;
}

/**
 * Whether the current key+provider pair still needs its model list. False
 * while detection is still running (the key may not be finished) and once the
 * list for this exact pair is in hand.
 */
export function shouldListModels(state: Pick<AiKeyFormState, 'provider' | 'key' | 'detecting' | 'modelsFor'>): boolean {
  const token = modelToken(state.provider, state.key);
  return token !== null && !state.detecting && state.modelsFor !== token;
}

/**
 * The model list for this key+provider has not answered yet: queued for the
 * debounce, in flight, or not started. The form's "Loading models…" line and
 * Save's disabled state both read this, so the two cannot disagree.
 */
export function isModelListPending(input: {
  modelsLoading: boolean;
  modelsLoaded: boolean;
  modelsError: boolean;
}): boolean {
  return input.modelsLoading || (!input.modelsLoaded && !input.modelsError);
}

/**
 * Whether Save may store the key: a plausible key, a provider, detection
 * settled, and the model list settled (loaded or failed) for this pair. While
 * detection runs or the debounced list is still due, Save would store the key
 * with no model even though the screen says the models are loading.
 */
export function canSaveAiKey(input: {
  key: string;
  provider: AiProviderId | null;
  detecting: boolean;
  modelsLoading: boolean;
  modelsLoaded: boolean;
  modelsError: boolean;
}): boolean {
  if (input.key.trim().length < MIN_AI_KEY_LENGTH) return false;
  if (input.provider === null) return false;
  if (input.detecting) return false;
  return !isModelListPending(input);
}

/** Everything a new key or provider invalidates: list, pick, list error, attempt token. */
function clearedPair(state: AiKeyFormState): Pick<AiKeyFormState, 'models' | 'modelsFor' | 'modelsLoading' | 'modelsError' | 'model' | 'modelQuery' | 'attemptedToken'> {
  return { models: [], modelsFor: null, modelsLoading: false, modelsError: null, model: null, modelQuery: '', attemptedToken: null };
}

function labelOf(state: AiKeyFormState, id: string): string {
  return state.models.find((model) => model.id === id)?.name ?? id;
}

export function aiKeyFormReducer(state: AiKeyFormState, event: AiKeyFormEvent): AiKeyFormState {
  switch (event.type) {
    case 'keyEdited': {
      const trimmed = event.key.trim();
      if (trimmed === state.key.trim()) return { ...state, key: event.key };
      // A new key belongs to a new pair: detection re-runs and a provider that
      // was guessed for the old key is dropped. A hand-picked provider stays.
      return {
        ...state,
        key: event.key,
        provider: state.providerChosen ? state.provider : null,
        detected: null,
        detecting: false,
        ...clearedPair(state),
      };
    }
    case 'detectStarted':
      return state.detecting ? state : { ...state, detecting: true };
    case 'detected':
      return {
        ...state,
        detecting: false,
        detected: event.provider,
        provider: event.provider !== null && !state.providerChosen ? event.provider : state.provider,
      };
    case 'providerChosen':
      return { ...state, provider: event.provider, providerChosen: true, ...clearedPair(state) };
    case 'modelsStarted': {
      const retry = state.attemptedToken === event.token;
      return {
        ...state,
        modelsLoading: true,
        modelsError: null,
        models: retry ? state.models : [],
        model: retry ? state.model : null,
        modelQuery: retry ? state.modelQuery : '',
        attemptedToken: event.token,
      };
    }
    case 'modelsLoaded': {
      if (state.attemptedToken !== event.token) return state;
      const kept = state.model !== null && event.models.some((model) => model.id === state.model);
      return {
        ...state,
        models: event.models,
        modelsFor: event.token,
        modelsLoading: false,
        modelsError: null,
        model: kept ? state.model : null,
        modelQuery: kept ? state.modelQuery : '',
      };
    }
    case 'modelsFailed': {
      if (state.attemptedToken !== event.token) return state;
      return {
        ...state,
        models: [],
        modelsFor: event.token,
        modelsLoading: false,
        modelsError: { message: event.message, retryable: event.retryable },
      };
    }
    case 'modelQueryEdited': {
      // Typing searches; it does not unchoose. A dropped pick would be saved
      // with no model and the card cannot set one (only a new key can). Only
      // clearing the field unchoses. Z.ai is the exception: its typed text is
      // the model, so the text replaces the pick.
      if (state.provider === 'zai') {
        const keep = state.model !== null && labelOf(state, state.model) === event.text ? state.model : null;
        return { ...state, modelQuery: event.text, model: keep };
      }
      return { ...state, modelQuery: event.text, model: event.text.trim() === '' ? null : state.model };
    }
    case 'modelCommitted':
      return { ...state, model: event.id, modelQuery: labelOf(state, event.id) };
    case 'retryModels':
      // Keeping attemptedToken makes modelsStarted treat this as a retry, so
      // the chosen/typed model survives the new request.
      return { ...state, modelsFor: null, modelsError: null };
    case 'reset':
      return initialAiKeyForm();
  }
}
