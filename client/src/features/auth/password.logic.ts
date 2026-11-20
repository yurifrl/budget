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
import { passwordRejection, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type PasswordRejection } from '@shared/password-policy';

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

export const GENERIC_FAILURE = 'Something went wrong. Please try again.';
export const NETWORK_FAILURE = 'Can’t reach the server. Check your connection and try again.';
export const CHANGE_LINK_EXPIRED =
  'The time to choose a new password ran out. Sign in again with your temporary password. If it has expired, ask the administrator for a new one.';

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
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.ceil(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** Plain-language wording of each password rejection (what to do, not what the API said). */
export const POLICY_MESSAGES: Readonly<Record<PasswordRejection, string>> = {
  password_too_short: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  password_too_long: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  password_is_email: 'The password can’t be your e-mail address.',
  password_too_common: 'That password is too common. Choose another one.',
  password_unchanged: 'Choose a password different from the current one.',
};

export function isPolicyCode(code: string | null): code is PasswordRejection {
  return code !== null && Object.prototype.hasOwnProperty.call(POLICY_MESSAGES, code);
}

/** What to tell the person about a failed request of the given form. */
export function failureMessage(kind: PasswordFormKind, f: PasswordFailure): string {
  if (f.status === 0) return NETWORK_FAILURE;
  if (f.status === 429 || f.code === 'too_many_attempts') {
    return f.retryAfter === null
      ? 'Too many attempts. Wait a few minutes and try again.'
      : `Too many attempts. Try again in ${formatWait(f.retryAfter)}.`;
  }
  if (isPolicyCode(f.code)) return POLICY_MESSAGES[f.code];
  switch (f.code) {
    case 'invalid_credentials':
      return kind === 'change' ? 'The current password is not right.' : 'Wrong e-mail or password.';
    case 'temp_password_expired':
      return kind === 'complete'
        ? CHANGE_LINK_EXPIRED
        : 'Your temporary password has expired. Ask the administrator for a new one.';
    case 'invalid_change_token':
      return CHANGE_LINK_EXPIRED;
    case 'no_password':
      return 'This account has no password to change. It signs in another way.';
    case 'forbidden':
      return 'Your password can’t be changed from this kind of session. Sign out, sign in with your e-mail and password, and try again.';
    case 'origin_not_allowed':
      return 'Signing in is not allowed from this address.';
    case 'invalid_input':
      return kind === 'login' ? 'Enter your e-mail and password.' : 'Check the form and try again.';
  }
  if (f.status === 404) return 'Password sign-in is turned off.';
  if (f.status === 401 && kind === 'login') return 'Wrong e-mail or password.';
  return GENERIC_FAILURE;
}

/** The new-password step must restart from the sign-in form when its token is dead. */
export function changeTokenDead(f: PasswordFailure): boolean {
  return f.code === 'invalid_change_token' || f.code === 'temp_password_expired';
}

export type FormCheck<T> = { ok: true; value: T } | { ok: false; error: string };

export function checkLogin(email: string, password: string): FormCheck<{ email: string; password: string }> {
  const e = email.trim();
  if (!e || !password) return { ok: false, error: 'Enter your e-mail and password.' };
  return { ok: true, value: { email: e, password } };
}

/** A chosen password plus its confirmation, checked before anything is sent. */
export function checkNewPassword(password: string, confirm: string, email: string): FormCheck<string> {
  const rejection = passwordRejection(password, email);
  if (rejection) return { ok: false, error: POLICY_MESSAGES[rejection] };
  if (password !== confirm) return { ok: false, error: 'The two passwords don’t match.' };
  return { ok: true, value: password };
}

export function checkChange(
  current: string,
  password: string,
  confirm: string,
  email: string,
): FormCheck<{ current: string; next: string }> {
  if (!current) return { ok: false, error: 'Enter your current password.' };
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

export const CHANGE_HEADLINE = 'Choose a new password.';
export const CHANGE_BODY = 'You signed in with a temporary password. Choose your own to continue. Use at least 12 characters; a few ordinary words strung together work well.';
export const OR_EMAIL_LABEL = 'or sign in with e-mail';
