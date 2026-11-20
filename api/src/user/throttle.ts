/**
 * Password sign-in throttling rules (pure) and the per-IP limiter (memory).
 *
 * Per e-mail (stored in auth_login_throttle, see ./password-store.ts): after
 * LOCK_AFTER consecutive failures the e-mail is locked for 1 minute, and each
 * further failure (after the lock ends) doubles it up to 15 minutes. A
 * success or an admin reset clears the count. Unknown e-mails are counted the
 * same way, so a lockout says nothing about whether an account exists.
 *
 * Per client address (CF-Connecting-IP when present): at most
 * IP_MAX_FAILURES failures per IP_WINDOW_MS window, per process.
 */
export const LOCK_AFTER = 5;
const BASE_LOCK_SECONDS = 60;
const MAX_LOCK_SECONDS = 15 * 60;

/** Lock length (seconds) after the n-th consecutive failure; 0 = not locked. */
export function lockSecondsAfter(failures: number): number {
  if (failures < LOCK_AFTER) return 0;
  const doublings = Math.min(failures - LOCK_AFTER, 10);
  return Math.min(BASE_LOCK_SECONDS * 2 ** doublings, MAX_LOCK_SECONDS);
}

/** Retry-After (whole seconds, >= 1) for a lock ending at `lockedUntil`; 0 = not locked. */
export function retryAfterSeconds(lockedUntil: Date | null, now: Date = new Date()): number {
  if (!lockedUntil) return 0;
  const ms = lockedUntil.getTime() - now.getTime();
  return ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : 0;
}

export const IP_MAX_FAILURES = 30;
export const IP_WINDOW_MS = 15 * 60 * 1000;

const ipFailures = new Map<string, { count: number; start: number }>();

function bucket(ip: string, now: number) {
  const b = ipFailures.get(ip);
  if (!b || now - b.start >= IP_WINDOW_MS) return null;
  return b;
}

/** Seconds this address must wait (0 = may try). */
export function ipRetryAfter(ip: string, now = Date.now()): number {
  const b = bucket(ip, now);
  if (!b || b.count < IP_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((b.start + IP_WINDOW_MS - now) / 1000));
}

export function recordIpFailure(ip: string, now = Date.now()): void {
  const b = bucket(ip, now);
  if (b) b.count++;
  else ipFailures.set(ip, { count: 1, start: now });
  // Keep the map bounded: drop expired windows once it grows.
  if (ipFailures.size > 10_000) for (const [k, v] of ipFailures) if (now - v.start >= IP_WINDOW_MS) ipFailures.delete(k);
}

/** Tests only. */
export function resetIpLimiter(): void {
  ipFailures.clear();
}
