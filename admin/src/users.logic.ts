import type { AdminUser } from '@shared/contracts/user';
import { getLocale, labels } from '@shared/i18n';

import { t } from './pages/users/i18n';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "5 days", "3 hours", "12 minutes". `up` rounds the count up (time left); default rounds down (time elapsed). */
export function duration(ms: number, up = false): string {
  const round = up ? Math.ceil : Math.floor;
  if (ms >= DAY) return t('time.day', { count: round(ms / DAY) });
  if (ms >= HOUR) return t('time.hour', { count: round(ms / HOUR) });
  return t('time.minute', { count: Math.max(1, round(ms / MIN)) });
}

export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return t('relative.never');
  const ms = now - new Date(iso).getTime();
  if (ms < MIN) return t('relative.justNow');
  return t('relative.ago', { time: duration(ms) });
}

export interface SignInMethods {
  password: boolean;
  google: boolean;
}
export const signInMethods = (u: Pick<AdminUser, 'has_password' | 'has_google'>): SignInMethods => ({
  password: u.has_password,
  google: u.has_google,
});

/** State of the password credential: temp password / expired / set / none. */
export function passwordState(
  u: Pick<AdminUser, 'has_password' | 'must_change_password' | 'temp_expires_at'>,
  now: number,
): { label: string; tone: 'none' | 'ok' | 'warn' | 'bad' } {
  if (!u.has_password) return { label: t('password.none'), tone: 'none' };
  if (!u.must_change_password) return { label: t('password.set'), tone: 'ok' };
  if (!u.temp_expires_at) return { label: t('password.tempMustChange'), tone: 'warn' };
  const left = new Date(u.temp_expires_at).getTime() - now;
  if (left <= 0) return { label: t('password.tempExpired'), tone: 'bad' };
  return { label: t('password.tempExpires', { time: duration(left, true) }), tone: 'warn' };
}

/** "locked until 14:32" while locked; null when not (or the lock has passed). */
export function lockLabel(lockedUntil: string | null, now: number): string | null {
  if (!lockedUntil) return null;
  const until = new Date(lockedUntil);
  if (until.getTime() <= now) return null;
  const time = until.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  return t('lock.until', { time });
}

export function signedInLabel(u: Pick<AdminUser, 'signed_in_at'>, now: number): string {
  return u.signed_in_at ? t('signedIn.at', { when: relativeTime(u.signed_in_at, now) }) : t('signedIn.never');
}

export function matchesFilter(u: Pick<AdminUser, 'email' | 'name'>, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return u.email.toLowerCase().includes(s) || (u.name ?? '').toLowerCase().includes(s);
}

export interface SelfLimits {
  isSelf: boolean;
  /** Disable / demote / delete are off: this is the signed-in admin, or `/me` is unresolved so nobody can be told apart. */
  locked: boolean;
  /** Why they are off; null when allowed. */
  hint: string | null;
}
export const selfLimits = (u: Pick<AdminUser, 'email'>, meEmail: string | null): SelfLimits => {
  if (!meEmail) return { isSelf: false, locked: true, hint: t('self.checking') };
  const isSelf = u.email.toLowerCase() === meEmail.toLowerCase();
  return {
    isSelf,
    locked: isSelf,
    hint: isSelf ? t('self.you') : null,
  };
};

const MESSAGES: Record<string, string> = labels(t, {
  unauthorized: 'error.unauthorized',
  account_disabled: 'error.accountDisabled',
  forbidden: 'error.forbidden',
  origin_not_allowed: 'error.originNotAllowed',
  not_found: 'error.notFound',
  user_exists: 'error.userExists',
  cannot_modify_self: 'error.cannotModifySelf',
  last_admin: 'error.lastAdmin',
  user_has_data: 'error.userHasData',
  password_login_disabled: 'error.passwordLoginDisabled',
});

export function errorMessage(code: string | undefined, fallback: string, status?: number | 'network'): string {
  if (status === 'network') return t('error.network');
  // 400 invalid_input carries the server's own reason (e.g. "this e-mail is reserved"): keep it, with a lead-in.
  if (code === 'invalid_input') return t('error.notAccepted', { reason: fallback });
  return (code && MESSAGES[code]) || fallback;
}
