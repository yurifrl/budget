/**
 * Post-login `return_to` validation. Login may send the browser back to a
 * path on THIS origin (the OAuth consent flow); anything that could leave the
 * origin is rejected so /auth/google can never become an open redirect.
 *
 * Accepted: a single-slash relative path. Rejected: absolute URLs, scheme-
 * relative (`//host`), backslashes (browsers treat `\` as `/`), control
 * characters, and anything that does not resolve back to the same origin.
 */
const SAFE_PATH = /^\/(?![/\\])[^\\\u0000-\u001f\u007f]*$/;
const PROBE_ORIGIN = 'https://return-to.invalid';

export function safeReturnTo(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  if (!SAFE_PATH.test(raw)) return null;
  try {
    return new URL(raw, PROBE_ORIGIN).origin === PROBE_ORIGIN ? raw : null;
  } catch {
    return null;
  }
}
