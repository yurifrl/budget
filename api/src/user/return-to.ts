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

/**
 * Where a successful sign-in may send the browser: a safe relative path on
 * the API (resolved against `apiBaseUrl`, as the Google callback does) or an
 * absolute http(s) URL on the web app's origin (`appOrigin`) with no
 * credentials. Anything else, including an absent value, is null (the caller
 * falls back to the app origin).
 */
export function safeLoginRedirect(raw: string | undefined | null, apiBaseUrl: string, appOrigin: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  if (raw.startsWith('/')) {
    const path = safeReturnTo(raw);
    return path ? `${apiBaseUrl}${path}` : null;
  }
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let target: URL;
  let app: URL;
  try {
    target = new URL(raw);
    app = new URL(appOrigin);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  if (target.username || target.password) return null;
  return target.origin === app.origin ? target.toString() : null;
}
