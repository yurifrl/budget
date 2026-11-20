import type { AdminUser } from '@shared/contracts/user';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "5 days", "3 hours", "12 minutes". `up` rounds the count up (time left); default rounds down (time elapsed). */
export function duration(ms: number, up = false): string {
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const round = up ? Math.ceil : Math.floor;
  if (ms >= DAY) return unit(round(ms / DAY), 'day');
  if (ms >= HOUR) return unit(round(ms / HOUR), 'hour');
  return unit(Math.max(1, round(ms / MIN)), 'minute');
}

export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const ms = now - new Date(iso).getTime();
  if (ms < MIN) return 'just now';
  return `${duration(ms)} ago`;
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
  if (!u.has_password) return { label: 'no password', tone: 'none' };
  if (!u.must_change_password) return { label: 'password set', tone: 'ok' };
  if (!u.temp_expires_at) return { label: 'temp password, must change', tone: 'warn' };
  const left = new Date(u.temp_expires_at).getTime() - now;
  if (left <= 0) return { label: 'temp password expired', tone: 'bad' };
  return { label: `temp password, expires in ${duration(left, true)}`, tone: 'warn' };
}

/** "locked until 14:32" while locked; null when not (or the lock has passed). */
export function lockLabel(lockedUntil: string | null, now: number): string | null {
  if (!lockedUntil) return null;
  const t = new Date(lockedUntil);
  if (t.getTime() <= now) return null;
  const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `locked until ${time}`;
}

export function signedInLabel(u: Pick<AdminUser, 'signed_in_at'>, now: number): string {
  return u.signed_in_at ? `signed in ${relativeTime(u.signed_in_at, now)}` : 'never signed in';
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
  if (!meEmail) return { isSelf: false, locked: true, hint: 'Checking who you are: disable and delete stay off until your identity is known.' };
  const isSelf = u.email.toLowerCase() === meEmail.toLowerCase();
  return {
    isSelf,
    locked: isSelf,
    hint: isSelf ? 'This is you: you cannot disable, demote or delete your own account.' : null,
  };
};

const MESSAGES: Record<string, string> = {
  unauthorized: 'You are signed out. Sign in again and retry.',
  account_disabled: 'Your account is disabled.',
  forbidden: 'Only an admin signed in at the app or admin can do this.',
  origin_not_allowed: 'This page is not an allowed origin for the API.',
  not_found: 'That user no longer exists (or cannot be managed). Refresh the list.',
  user_exists: 'A user with that e-mail already exists.',
  cannot_modify_self: 'You cannot disable, demote or delete your own account.',
  last_admin: 'This is the last active admin: it cannot be disabled, demoted or deleted.',
  user_has_data: 'This user has data (budgets, memberships, accounts...) and cannot be deleted. Disable the user instead.',
  password_login_disabled: 'Password login is turned off on the server (AUTH_PASSWORD_LOGIN=0).',
};

export function errorMessage(code: string | undefined, fallback: string, status?: number | 'network'): string {
  if (status === 'network') return 'Cannot reach the API. Check your connection and that the API is running, then retry.';
  return (code && MESSAGES[code]) || fallback;
}
