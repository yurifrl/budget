/**
 * Pure rules of the AI key screen: which state the page is in, the provider
 * table (five fixed brands), what a detection result means, the save-time
 * checks and one message per AI error code. Wire-typed, so it lives beside
 * the screen (not in domain/). No React here: the hook stays thin and the
 * tests drive these directly.
 */

import {
  AI_ENCRYPTION_MISSING,
  AI_KEY_REJECTED,
  AI_KEY_REQUIRED,
  AI_KEY_UNREADABLE,
  AI_MODEL_UNKNOWN,
  AI_PROVIDER_MISMATCH,
  AI_PROVIDER_UNKNOWN,
  AI_PROVIDERS,
  AI_SHARED_KEY_MISSING,
  AI_SHARED_MODEL_MISSING,
  type AiProviderId,
} from '@shared/contracts/ai';

import type { AiCredentialStatus, AiModel } from '@/budget/data/api';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { t } from './i18n';

/** Mirrors the contract's `apiKey.min(8)`: shorter text cannot be a key. */
export const MIN_AI_KEY_LENGTH = 8;

export type AiKeysScreenMode =
  /** First answer of the status read not in yet. */
  | 'loading'
  /** The status could not be read. */
  | 'failed'
  /** An own credential is saved; the screen shows it back (never the key). */
  | 'saved'
  /** No own key, but the installation's shared AI is available to this account. */
  | 'shared'
  /**
   * A stored row this server cannot use (unknown provider or unreadable
   * secret). It also blocks the shared fallback, so shared AI must not be
   * presented as in use: the person must save a new key or remove the row.
   */
  | 'blocked'
  /** Neither: only the form. */
  | 'empty';

export function aiKeysScreenMode(input: {
  status: AiCredentialStatus | undefined;
  isError: boolean;
}): AiKeysScreenMode {
  const { status, isError } = input;
  if (!status) return isError ? 'failed' : 'loading';
  if (status.own !== null) return 'saved';
  if (!status.shared.available) return 'empty';
  return status.effective === 'shared' ? 'shared' : 'blocked';
}

/** A brand name for a provider id; never a raw wire value on screen. */
export function providerLabel(provider: AiProviderId): string {
  switch (provider) {
    case 'openrouter':
      return t('provider.openrouter');
    case 'anthropic':
      return t('provider.anthropic');
    case 'openai':
      return t('provider.openai');
    case 'zai':
      return t('provider.zai');
    case 'deepseek':
      return t('provider.deepseek');
  }
}

/** The five providers in the order the picker shows them (Z.ai included: never detected, always chooseable). */
export function providerOptions(): readonly { id: AiProviderId; label: string }[] {
  return AI_PROVIDERS.map((id) => ({ id, label: providerLabel(id) }));
}

export interface AiKeyFormError {
  /** 'key' sits under the key field; 'form' under the buttons. */
  field: 'key' | 'form';
  message: string;
}

/**
 * Save-time checks (the server validates too; this keeps the button honest).
 * The model is optional in the contract and here: a key can be saved while its
 * model list cannot be fetched (rate limit, provider unavailable).
 */
export function checkSaveInput(input: { apiKey: string; provider: AiProviderId | null }): AiKeyFormError | null {
  if (input.apiKey.trim().length < MIN_AI_KEY_LENGTH) return { field: 'key', message: t('form.keyTooShort') };
  if (input.provider === null) return { field: 'form', message: t('form.providerRequired') };
  return null;
}

/** The line under the key field: detection progress, the detected provider, or "choose one". */
export function detectionHint(input: {
  keyLength: number;
  detecting: boolean;
  provider: AiProviderId | null;
  detected: AiProviderId | null;
}): string | null {
  const { keyLength, detecting, provider, detected } = input;
  if (keyLength < MIN_AI_KEY_LENGTH) return null;
  if (detecting) return t('form.detecting');
  if (provider === null) return t('form.providerUnknown');
  if (detected !== null && detected !== provider) {
    return t('form.providerDiffers', { detected: providerLabel(detected), chosen: providerLabel(provider) });
  }
  if (detected !== null) return t('form.detected', { provider: providerLabel(detected) });
  return t('form.providerChosen');
}

/** Model rows for the picker: the provider's name, the id as the sub-line when it differs. */
export function modelOptions(models: readonly AiModel[]): { key: string; label: string; sub?: string }[] {
  return models.map((model) => {
    const label = model.name !== '' ? model.name : model.id;
    return { key: model.id, label, ...(label !== model.id ? { sub: model.id } : {}) };
  });
}

/** The `{ status, message, code }` an RTK Query request rejects with (platform/api/baseQuery). */
interface ApiErrorLike {
  status?: unknown;
  message?: unknown;
  code?: unknown;
}

function asApiError(error: unknown): ApiErrorLike {
  return typeof error === 'object' && error !== null ? (error as ApiErrorLike) : {};
}

/** Catalog keys with one message per error code the screen must explain. */
export type AiErrorKey =
  | 'error.keyRejected'
  | 'error.providerUnknown'
  | 'error.providerMismatch'
  | 'error.modelUnknown'
  | 'error.keyRequired'
  | 'error.encryptionMissing'
  | 'error.keyUnreadable'
  | 'error.sharedKeyMissing'
  | 'error.sharedModelMissing'
  | 'error.rateLimited'
  | 'error.providerUnavailable';

/**
 * Code → catalog key, by the body's code alone. A status fallback would guess
 * (the same code can arrive with another status), and a 429/502 without its
 * code goes to apiErrorMessage like any other unknown. `rate_limited` and
 * `upstream_error` are the provider's own transport codes.
 */
const AI_ERROR_KEY: Record<string, AiErrorKey> = {
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

export function aiErrorKey(code: unknown): AiErrorKey | undefined {
  return typeof code === 'string' ? AI_ERROR_KEY[code] : undefined;
}

/** One sentence for a failed AI request: our message for a known code, else the shared error path. */
export function aiErrorView(error: unknown): string {
  const key = aiErrorKey(asApiError(error).code);
  return key !== undefined ? t(key) : apiErrorMessage(error, t('error.generic'));
}

/**
 * A failed model-list request. Only rate limiting, an upstream failure and a
 * dead connection are worth a Retry (and a typed model / saving without one):
 * a rejected key or an unknown provider is for the person to fix first.
 */
export interface ModelListFailure {
  message: string;
  retryable: boolean;
}

export function modelListFailure(error: unknown): ModelListFailure {
  const e = asApiError(error);
  const retryable = e.code === 'rate_limited' || e.code === 'upstream_error' || e.status === 'FETCH_ERROR';
  return { message: aiErrorView(error), retryable };
}

/**
 * The status shows an own key, but the server cannot open it (master key
 * changed). This shape becomes reachable with budget-ucyr's ownKeyUsable:
 * on main the server answers effective 'own' whenever own is non-null, so the
 * screen is written ahead of it on purpose.
 */
export function ownKeyUnreadable(status: AiCredentialStatus): boolean {
  return status.own !== null && status.effective === null;
}

/** Result of {@link runCredentialAction}: skipped because one is already in flight, or its outcome. */
export type CredentialActionResult<T> =
  | { ran: false }
  | { ran: true; ok: true; value: T }
  | { ran: true; ok: false; error: unknown };

/**
 * Run one credential request at most once at a time and reset its mutation
 * entry when it settles, so a double tap cannot send the key twice and the
 * request arguments (the key) do not stay in the redux store.
 */
export async function runCredentialAction<T>(
  inFlight: { current: boolean },
  run: () => { unwrap(): Promise<T> },
  reset: () => void,
): Promise<CredentialActionResult<T>> {
  if (inFlight.current) return { ran: false };
  inFlight.current = true;
  try {
    return { ran: true, ok: true, value: await run().unwrap() };
  } catch (error) {
    return { ran: true, ok: false, error };
  } finally {
    reset();
    inFlight.current = false;
  }
}
