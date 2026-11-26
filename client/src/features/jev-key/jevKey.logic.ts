/**
 * Pure rules of the Jev key screen: which state the card is in, whether the
 * field holds something worth sending, and what an API failure means in
 * words. Wire-typed, so it lives beside the screen (not in domain/).
 */
import {
  CREDENTIALS_KEY_MISSING,
  JEV_KEY_MISSING,
  JEV_KEY_REJECTED,
  JEV_NO_CREDITS,
  JEV_UNAVAILABLE,
  type JevKeyStatus,
} from '@shared/contracts/jev';

import { apiErrorCode, apiErrorMessage } from '@/platform/api/baseQuery';
import { t } from './i18n';

export type JevKeyCardMode =
  /** First answer not in yet. */
  | 'loading'
  /** The status could not be read. */
  | 'failed'
  /** No key saved (or the person is replacing one): the field. */
  | 'form'
  /** A key is saved: masked ending, date, test and remove. */
  | 'saved';

export function jevKeyCardMode(input: {
  status: JevKeyStatus | undefined;
  isLoading: boolean;
  isError: boolean;
  replacing: boolean;
}): JevKeyCardMode {
  const { status, isLoading, isError, replacing } = input;
  if (!status) {
    if (isError) return 'failed';
    return isLoading ? 'loading' : 'form';
  }
  if (status.last_four === null) return 'form';
  return replacing ? 'form' : 'saved';
}

/** No own key, and the installation's key is available to this person. */
export function serverKeyInUse(status: JevKeyStatus | undefined): boolean {
  return status != null && status.last_four === null && status.using_server_key;
}

/** What still blocks the save button, or null when the field can be sent. */
export function keyFieldProblem(raw: string): string | null {
  if (raw.trim() !== '') return null;
  return t('error.required');
}

/**
 * The LOCAL calendar day of `saved_at`, as the date formatter takes it
 * (YYYY-MM-DD): slicing the ISO string would show the UTC day, which is the
 * wrong day for a key saved late in the evening east of Greenwich.
 */
export function savedOn(status: JevKeyStatus): string | null {
  if (status.saved_at === null) return null;
  const at = new Date(status.saved_at);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** What a failed save says: a refused key is the person's to fix, the rest is ours. */
export function saveErrorMessage(error: unknown): string {
  switch (apiErrorCode(error)) {
    case JEV_KEY_REJECTED:
      return t('error.rejected');
    case JEV_UNAVAILABLE:
      return t('error.unavailable');
    case JEV_NO_CREDITS:
      return t('error.noCredits');
    case CREDENTIALS_KEY_MISSING:
      return t('error.noEncryption');
    default:
      return apiErrorMessage(error, t('error.saveFailed'));
  }
}

/**
 * What a failed test says. A refused saved key is worth saying out loud, and a
 * key that cannot be decrypted must not read as "no key saved" — the status
 * says which it is.
 */
export function testErrorMessage(error: unknown, status: JevKeyStatus | undefined): string {
  switch (apiErrorCode(error)) {
    case JEV_KEY_REJECTED:
      return t('error.rejected');
    case JEV_KEY_MISSING:
      // A saved key that cannot be decrypted answers the same code as "none".
      return status?.reason === 'key_unreadable' || status?.last_four != null
        ? t('error.unreadable')
        : t('error.codeMissing');
    case JEV_UNAVAILABLE:
      return t('error.unavailable');
    case JEV_NO_CREDITS:
      return t('error.noCredits');
    default:
      return apiErrorMessage(error, t('error.testFailed'));
  }
}

export function loadErrorMessage(error: unknown): string {
  return apiErrorMessage(error, t('error.loadFailed'));
}

/** What a failed remove says. Removing never reaches Jev, so it is our failure. */
export function removeErrorMessage(error: unknown): string {
  return apiErrorMessage(error, t('error.removeFailed'));
}

/** The sentence under a saved key whose bytes this server cannot open. */
export function unreadableNotice(status: JevKeyStatus | undefined): string | null {
  return status?.reason === 'key_unreadable' ? t('error.unreadable') : null;
}
