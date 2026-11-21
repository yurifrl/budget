/**
 * Pure rules of the own Pluggy keys flow: which state the "Your Pluggy keys"
 * screen is in, what an API error on save means for the form, whether
 * "Connect a bank" may open the widget or must lead to the keys screen, and
 * what a paused connection tells its owner. Wire-typed, so it lives beside
 * the screen (not in domain/).
 */

import {
  CREDENTIALS_KEY_MISSING,
  INVALID_CREDENTIALS,
  OWN_KEYS_REQUIRED,
} from '@shared/contracts/connections';

import type { ConnectionCredentialsJson, ConnectionJson } from '@/budget/data/connections';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { storedServerMessage } from '../model/serverMessage';
import { t } from './i18n';

/** The keys screen route. `?reason=connect` = the user came from a blocked connect. */
export const PLUGGY_KEYS_ROUTE = '/pluggy-keys';
export const PLUGGY_KEYS_FROM_CONNECT = `${PLUGGY_KEYS_ROUTE}?reason=connect`;

/** The feature that lets a person use the installation's shared Pluggy keys. */
export const SHARED_KEY_FEATURE = 'shared-pluggy-key';

/** MeuPluggy's limit on connections per personal application. */
export const MEUPLUGGY_CONNECTION_LIMIT = 5;

export type KeysScreenMode =
  /** First answer not in yet. */
  | 'loading'
  /** The status could not be read. */
  | 'failed'
  /** No key set saved: the entry form. */
  | 'empty'
  /** A key set is saved: client id shown, secret only as "saved". */
  | 'saved'
  /** A key set is saved and the user is replacing it. */
  | 'replacing';

export function keysScreenMode(input: {
  credentials: Pick<ConnectionCredentialsJson, 'clientId' | 'hasSecret'> | undefined;
  isLoading: boolean;
  isError: boolean;
  replacing: boolean;
}): KeysScreenMode {
  const { credentials, isLoading, isError, replacing } = input;
  if (!credentials) {
    if (isError) return 'failed';
    return isLoading ? 'loading' : 'empty';
  }
  if (!hasOwnKeys(credentials)) return 'empty';
  return replacing ? 'replacing' : 'saved';
}

/** A usable own key set is stored (client id and secret). */
export function hasOwnKeys(credentials: Pick<ConnectionCredentialsJson, 'clientId' | 'hasSecret'> | undefined): boolean {
  return credentials != null && credentials.clientId != null && credentials.hasSecret;
}

/** Which field an error belongs to; 'form' = the whole form (shown under the buttons). */
export type KeysErrorField = 'clientId' | 'clientSecret' | 'form';

export interface KeysFormError {
  field: KeysErrorField;
  message: string;
}

/** The `{ status, message, code }` an RTK Query mutation rejects with (platform/api/baseQuery). */
interface ApiErrorLike {
  status?: unknown;
  message?: unknown;
  code?: unknown;
}

function asApiError(error: unknown): ApiErrorLike {
  return typeof error === 'object' && error !== null ? (error as ApiErrorLike) : {};
}

/** The stable error code of a rejected request, when the API sent one. */
export function apiErrorCode(error: unknown): string | undefined {
  const code = asApiError(error).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The translated sentence of a SPECIFIC API error code (`connection_paused`,
 * `own_keys_required`, ...), or undefined when the error has none (no code, or
 * a per-status one): the caller then falls back to its own sentence.
 */
function specificApiMessage(error: unknown): string | undefined {
  const marker = '';
  const message = apiErrorMessage(error, marker);
  return message === marker ? undefined : message;
}

/** Check before sending: both fields are required (the server trims too). */
export function checkKeysInput(clientId: string, clientSecret: string): KeysFormError | null {
  if (clientId.trim() === '') return { field: 'clientId', message: t('form.clientIdRequired') };
  if (clientSecret.trim() === '') return { field: 'clientSecret', message: t('form.clientSecretRequired') };
  return null;
}

/** What a failed save means for the form, by the API's error `code`. */
export function saveErrorView(error: unknown): KeysFormError {
  const e = asApiError(error);
  const serverMessage = typeof e.message === 'string' && e.message !== '' ? e.message : null;
  switch (apiErrorCode(error)) {
    case INVALID_CREDENTIALS:
      return {
        field: 'clientSecret',
        message: t('form.invalidCredentials'),
      };
    case CREDENTIALS_KEY_MISSING:
      return {
        field: 'form',
        message: t('form.keyMissing'),
      };
    case 'invalid_input': {
      // The validator names the field first: "clientId is invalid (...)".
      const message = serverMessage ?? t('form.inputFallback');
      if (/^clientSecret\b/.test(message)) return { field: 'clientSecret', message: t('form.secretInvalid') };
      if (/^clientId\b/.test(message)) return { field: 'clientId', message: t('form.clientIdInvalid') };
      return { field: 'form', message };
    }
    default:
      if (e.status === 'FETCH_ERROR') return { field: 'form', message: t('form.unreachable') };
      return { field: 'form', message: specificApiMessage(error) ?? serverMessage ?? t('form.saveFailed') };
  }
}

/** What a failed remove means (always a form-level message). */
export function deleteErrorMessage(error: unknown): string {
  const message = asApiError(error).message;
  return specificApiMessage(error) ?? (typeof message === 'string' && message !== '' ? message : t('form.removeFailed'));
}

/**
 * May "Connect a bank" open the widget? A new connection needs the user's
 * own key set, or the shared-key feature. 'wait' = the key status is not in
 * yet (the button shows busy instead of guessing).
 */
export type ConnectGate = 'connect' | 'needs_keys' | 'wait';

export function connectGate(input: {
  credentials: Pick<ConnectionCredentialsJson, 'clientId' | 'hasSecret'> | undefined;
  credentialsLoading: boolean;
  /** The user's 'shared-pluggy-key' value and whether it is the API's answer yet. */
  sharedKey: { allowed: boolean; status: 'loading' | 'ready' | 'failed' };
}): ConnectGate {
  const { credentials, credentialsLoading, sharedKey } = input;
  if (hasOwnKeys(credentials)) return 'connect';
  if (sharedKey.status === 'ready' && sharedKey.allowed) return 'connect';
  if (sharedKey.status === 'loading' || (credentialsLoading && !credentials)) return 'wait';
  // Only send the user away on two confirmed answers. When either read
  // failed, try the widget: the API still answers 403 own_keys_required,
  // which the flow turns into the same redirect.
  return credentials && sharedKey.status === 'ready' ? 'needs_keys' : 'connect';
}

/** The connect-token request was refused because the user has no usable key set. */
export function isOwnKeysRequired(error: unknown): boolean {
  return apiErrorCode(error) === OWN_KEYS_REQUIRED;
}

export interface PausedGuidance {
  /** Why (the server's status message, else a generic one). */
  why: string;
  /** What to do. */
  todo: string;
  /** Label of the button that opens the keys screen. */
  actionLabel: string;
}

/** What a paused connection tells its owner, or null when it is not paused. */
export function pausedGuidance(
  row: Pick<ConnectionJson, 'status' | 'status_message' | 'status_message_code' | 'key_source'>,
): PausedGuidance | null {
  if (row.status !== 'paused') return null;
  // The server's stored sentence, translated by its code when there is one.
  const why = storedServerMessage(row.status_message, row.status_message_code);
  if (row.key_source === 'own') {
    return {
      why: why ?? t('paused.ownWhy'),
      todo: t('paused.ownTodo'),
      actionLabel: t('paused.ownAction'),
    };
  }
  return {
    why: why ?? t('paused.sharedWhy'),
    todo: t('paused.sharedTodo'),
    actionLabel: t('paused.sharedAction'),
  };
}
