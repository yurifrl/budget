/**
 * E-mail + password sign-in and password change: everything that can be
 * decided without React or the network. Messages are plain words (never the
 * API's `error` text, which is written for developers); the codes come from
 * shared/src/contracts/user/password.ts.
 *
 * Passwords never leave the form components' state except in the request
 * body: not in redux (the requests bypass RTK Query on purpose, which would
 * cache mutation arguments), not in logs, not in URLs.
 */
import { tError } from '@shared/i18n/errors';
import { passwordRejection, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type PasswordRejection } from '@shared/password-policy';

import en from './i18n/en';
import { t } from './i18n';

/** A failed password request, reduced to what the screens need. */
export interface PasswordFailure {
  /** HTTP status; 0 when no response arrived. */
  status: number;
  code: string | null;
  /** Seconds to wait (429 only). */
  retryAfter: number | null;
}

/** The API answered but the new session token could not be stored: shown as the generic failure. */
export const SESSION_NOT_SAVED: PasswordFailure = { status: 200, code: 'session_not_saved', retryAfter: null };

export type PasswordFormKind = 'login' | 'complete' | 'change';

/**
 * The generic failure in the English source text (what tests compare with).
 * Code that shows it to a person calls `t('failure.generic')` instead: a
 * module-level constant would freeze the language the app booted with.
 */
export const GENERIC_FAILURE: string = en['failure.generic'];

/** `Retry-After` header (delay in seconds, or an HTTP date) -> whole seconds, or null. */
export function parseRetryAfter(raw: string | null | undefined, now: number = Date.now()): number | null {
  if (!raw) return null;
  const text = raw.trim();
  if (/^\d+$/.test(text)) return Math.max(1, Number(text));
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(1, Math.ceil((at - now) / 1000));
}

/** 90 -> "2 minutes", 45 -> "45 seconds", 3600 -> "1 hour". Rounds up so the wait is never understated. */
export function formatWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return t('wait.seconds', { count: s });
  const m = Math.ceil(s / 60);
  if (m < 60) return t('wait.minutes', { count: m });
  const h = Math.ceil(m / 60);
  return t('wait.hours', { count: h });
}

/**
 * Plain-language wording of each password rejection (what to do, not what the
 * API said). Getters, so the text follows the active language at read time.
 */
export const POLICY_MESSAGES: Readonly<Record<PasswordRejection, string>> = {
  get password_too_short() {
    return tError('password_too_short');
  },
  get password_too_long() {
    return tError('password_too_long');
  },
  get password_is_email() {
    return tError('password_is_email');
  },
  get password_too_common() {
    return tError('password_too_common');
  },
  get password_unchanged() {
    return tError('password_unchanged');
  },
};

export function isPolicyCode(code: string | null): code is PasswordRejection {
  return code !== null && Object.prototype.hasOwnProperty.call(POLICY_MESSAGES, code);
}

/** The dead-change-token explanation (also shown when the new-password step has no token left). */
export function changeLinkExpiredMessage(): string {
  return t('failure.changeLinkExpired');
}

/** What to tell the person about a failed request of the given form. */
export function failureMessage(kind: PasswordFormKind, f: PasswordFailure): string {
  if (f.status === 0) return t('failure.network');
  if (f.status === 429 || f.code === 'too_many_attempts') {
    return f.retryAfter === null
      ? t('failure.tooManyAttempts')
      : t('failure.tooManyAttemptsWait', { wait: formatWait(f.retryAfter) });
  }
  if (isPolicyCode(f.code)) return POLICY_MESSAGES[f.code];
  switch (f.code) {
    case 'invalid_credentials':
      return kind === 'change' ? t('failure.wrongPassword') : t('failure.wrongCredentials');
    case 'temp_password_expired':
      return kind === 'complete'
        ? changeLinkExpiredMessage()
        : t('failure.tempExpired');
    case 'invalid_change_token':
      return changeLinkExpiredMessage();
    case 'no_password':
      return tError('no_password');
    case 'forbidden':
      return t('failure.forbidden');
    case 'origin_not_allowed':
      return t('failure.originNotAllowed');
    case 'invalid_input':
      return kind === 'login' ? t('failure.enterCredentials') : t('failure.checkForm');
  }
  if (f.status === 404) return tError('password_login_disabled');
  if (f.status === 401 && kind === 'login') return t('failure.wrongCredentials');
  return t('failure.generic');
}

/** The new-password step must restart from the sign-in form when its token is dead. */
export function changeTokenDead(f: PasswordFailure): boolean {
  return f.code === 'invalid_change_token' || f.code === 'temp_password_expired';
}

export type FormCheck<T> = { ok: true; value: T } | { ok: false; error: string };

export function checkLogin(email: string, password: string): FormCheck<{ email: string; password: string }> {
  const e = email.trim();
  if (!e || !password) return { ok: false, error: t('failure.enterCredentials') };
  return { ok: true, value: { email: e, password } };
}

/** A chosen password plus its confirmation, checked before anything is sent. */
export function checkNewPassword(password: string, confirm: string, email: string): FormCheck<string> {
  const rejection = passwordRejection(password, email);
  if (rejection) return { ok: false, error: POLICY_MESSAGES[rejection] };
  if (password !== confirm) return { ok: false, error: t('form.passwordMismatch') };
  return { ok: true, value: password };
}

export function checkChange(
  current: string,
  password: string,
  confirm: string,
  email: string,
): FormCheck<{ current: string; next: string }> {
  if (!current) return { ok: false, error: t('form.enterCurrent') };
  const next = checkNewPassword(password, confirm, email);
  if (!next.ok) return next;
  if (next.value === current) return { ok: false, error: POLICY_MESSAGES.password_unchanged };
  return { ok: true, value: { current, next: next.value } };
}

/** Live hint under the new-password field ('' when it is fine or still empty). */
export function newPasswordHint(password: string, email: string): string {
  if (!password) return '';
  const r = passwordRejection(password, email);
  return r ? POLICY_MESSAGES[r] : '';
}

/**
 * Input hints per field. `autoComplete` is read by browsers (and RN-web),
 * `textContentType` and `passwordRules` by iOS AutoFill / Strong Passwords.
 */
export const FIELD_HINTS = {
  email: { autoComplete: 'username', textContentType: 'username', keyboardType: 'email-address', autoCapitalize: 'none', autoCorrect: false },
  current: { autoComplete: 'current-password', textContentType: 'password', autoCapitalize: 'none', autoCorrect: false },
  new: {
    autoComplete: 'new-password',
    textContentType: 'newPassword',
    autoCapitalize: 'none',
    autoCorrect: false,
    passwordRules: `minlength: ${PASSWORD_MIN_LENGTH}; maxlength: ${PASSWORD_MAX_LENGTH};`,
  },
} as const;
