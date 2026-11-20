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
 * IP_MAX_ATTEMPTS attempts per IP_WINDOW_MS window, per process.
 *
 * Both are reserved BEFORE any verification, so parallel requests cannot run
 * more verifications than the budget allows.
 */
export const LOCK_AFTER = 5;
const BASE_LOCK_SECONDS = 60;
const MAX_LOCK_SECONDS = 15 * 60;

/** Lock length (seconds) starting with the n-th consecutive attempt; 0 = not locked. */
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

export const IP_MAX_ATTEMPTS = 30;
export const IP_WINDOW_MS = 15 * 60 * 1000;

const ipAttempts = new Map<string, { count: number; start: number }>();

/**
 * Reserve one password attempt for a client address BEFORE verifying
 * (attempts, not failures, are counted; a refusal is not). Synchronous, so it
 * is atomic within the process. Returns 0 when reserved, else the seconds to
 * wait.
 */
export function reserveIpAttempt(ip: string, now = Date.now()): number {
  let b = ipAttempts.get(ip);
  if (!b || now - b.start >= IP_WINDOW_MS) {
    b = { count: 0, start: now };
    ipAttempts.set(ip, b);
  }
  if (b.count >= IP_MAX_ATTEMPTS) return Math.max(1, Math.ceil((b.start + IP_WINDOW_MS - now) / 1000));
  b.count++;
  // Keep the map bounded: drop expired windows once it grows.
  if (ipAttempts.size > 10_000) for (const [k, v] of ipAttempts) if (now - v.start >= IP_WINDOW_MS) ipAttempts.delete(k);
  return 0;
}

/** Tests only. */
export function resetIpLimiter(): void {
  ipAttempts.clear();
}
