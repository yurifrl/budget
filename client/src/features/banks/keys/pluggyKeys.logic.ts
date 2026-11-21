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

/** Check before sending: both fields are required (the server trims too). */
export function checkKeysInput(clientId: string, clientSecret: string): KeysFormError | null {
  if (clientId.trim() === '') return { field: 'clientId', message: 'Enter the client id from your Pluggy application.' };
  if (clientSecret.trim() === '') return { field: 'clientSecret', message: 'Enter the client secret from your Pluggy application.' };
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
        message: 'Pluggy did not accept this client id and secret. Check both (copy them again from your application) and try again.',
      };
    case CREDENTIALS_KEY_MISSING:
      return {
        field: 'form',
        message: 'This server cannot store keys yet (its encryption key is not set up). Ask the admin, then try again.',
      };
    case 'invalid_input': {
      // The validator names the field first: "clientId is invalid (...)".
      const message = serverMessage ?? 'Check the client id and secret.';
      if (/^clientSecret\b/.test(message)) return { field: 'clientSecret', message: 'The client secret is too long or empty.' };
      if (/^clientId\b/.test(message)) return { field: 'clientId', message: 'The client id is too long or empty.' };
      return { field: 'form', message };
    }
    default:
      if (e.status === 'FETCH_ERROR') return { field: 'form', message: 'Could not reach the server. Check your connection and try again.' };
      return { field: 'form', message: serverMessage ?? 'Could not save your keys. Try again.' };
  }
}

/** What a failed remove means (always a form-level message). */
export function deleteErrorMessage(error: unknown): string {
  const message = asApiError(error).message;
  return typeof message === 'string' && message !== '' ? message : 'Could not remove your keys. Try again.';
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
  row: Pick<ConnectionJson, 'status' | 'status_message' | 'key_source'>,
): PausedGuidance | null {
  if (row.status !== 'paused') return null;
  if (row.key_source === 'own') {
    return {
      why: row.status_message ?? 'Paused: the Pluggy keys this bank was connected with are no longer saved.',
      todo: 'Save the same client id and secret again on Your Pluggy keys and it resumes by itself.',
      actionLabel: 'Your Pluggy keys',
    };
  }
  return {
    why: row.status_message ?? "Paused: this bank uses the app's shared Pluggy keys, which are not available for your account.",
    todo: 'Add your own Pluggy keys and connect this bank again, or ask the admin to turn shared keys back on for you (it then resumes by itself).',
    actionLabel: 'Add your Pluggy keys',
  };
}
