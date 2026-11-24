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
  /** Neither: only the form. */
  | 'empty';

export function aiKeysScreenMode(input: {
  status: AiCredentialStatus | undefined;
  isError: boolean;
}): AiKeysScreenMode {
  const { status, isError } = input;
  if (!status) return isError ? 'failed' : 'loading';
  if (status.own != null) return 'saved';
  return status.shared.available ? 'shared' : 'empty';
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
  /** 'key' / 'model' sit under their field; 'form' under the buttons. */
  field: 'key' | 'model' | 'form';
  message: string;
}

/** Save-time checks (the server validates too; this keeps the button honest). */
export function checkSaveInput(input: {
  apiKey: string;
  provider: AiProviderId | null;
  model: string | null;
}): AiKeyFormError | null {
  if (input.apiKey.trim().length < MIN_AI_KEY_LENGTH) return { field: 'key', message: t('form.keyTooShort') };
  if (input.provider === null) return { field: 'form', message: t('form.providerRequired') };
  if (input.model === null) return { field: 'model', message: t('form.modelRequired') };
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

/**
 * One sentence for a failed AI request. Every code the AI contracts define
 * has its own message; a provider 429 and upstream failures (502) are the
 * transport kinds the screen can also meet.
 */
export function aiErrorView(error: unknown): string {
  const e = asApiError(error);
  switch (e.code) {
    case AI_KEY_REJECTED:
      return t('error.keyRejected');
    case AI_PROVIDER_UNKNOWN:
      return t('error.providerUnknown');
    case AI_PROVIDER_MISMATCH:
      return t('error.providerMismatch');
    case AI_MODEL_UNKNOWN:
      return t('error.modelUnknown');
    case AI_KEY_REQUIRED:
      return t('error.keyRequired');
    case AI_ENCRYPTION_MISSING:
      return t('error.encryptionMissing');
    case AI_KEY_UNREADABLE:
      return t('error.keyUnreadable');
    case AI_SHARED_KEY_MISSING:
      return t('error.sharedKeyMissing');
    case AI_SHARED_MODEL_MISSING:
      return t('error.sharedModelMissing');
    default:
      break;
  }
  if (e.status === 429) return t('error.rateLimited');
  if (e.status === 502) return t('error.providerUnavailable');
  if (e.status === 'FETCH_ERROR') return t('error.unreachable');
  return apiErrorMessage(error, t('error.generic'));
}
