/**
 * Native (iOS/Android) Google sign-in flow — pure helpers, no React or RN
 * imports, so the flow logic is testable with bun:test.
 *
 * Flow: LoginGate asks the API to start the login (API mints an HMAC state
 * nonce), opens Google in the system browser, Google redirects to the API's
 * https callback, and the API bounces back to the app's deep link carrying the
 * authorization code plus the state nonce. The app exchanges code+state at
 * /auth/token for a session token (server/authz.ts) and stores it
 * (core/storage/sessionToken.ts).
 */

/** Query the API's callback hands back to the app on the deep link. */
export interface AuthCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

/** Result of parsing a deep link the API redirected back to the app. */
export type ParsedCallback =
  | { kind: 'success'; code: string; state: string }
  | { kind: 'error'; error: string };

/**
 * Parse a deep link URL the API bounced to the app. Accepts the code+state in
 * either the query string or a `#` fragment (native bounces may use either).
 */
export function parseAuthCallback(url: string): ParsedCallback {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // eslint-disable-next-line budget-i18n/no-untranslated-string -- developer error text; useSignIn shows a translated notice instead
    return { kind: 'error', error: 'invalid redirect' };
  }
  const params = new URLSearchParams(u.search);
  if (params.size === 0 && u.hash.length > 1) {
    for (const [k, v] of new URLSearchParams(u.hash.slice(1))) params.set(k, v);
  }
  const error = params.get('error');
  if (error) return { kind: 'error', error };
  const code = params.get('code');
  const state = params.get('state');
  if (code && state) return { kind: 'success', code, state };
  // eslint-disable-next-line budget-i18n/no-untranslated-string -- developer error text; useSignIn shows a translated notice instead
  return { kind: 'error', error: 'missing code or state in redirect' };
}

/** The server-side URL that starts a native login. */
export function nativeSignInUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/auth/google/native`;
}

/** The server-side URL that starts the web (cookie-based) login. */
export function webSignInUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/auth/google`;
}

/** Exchange an authorization code + state for a persisted session token. */
export async function fetchSessionToken(
  apiUrl: string,
  code: string,
  state: string,
): Promise<{ token: string } | { error: string }> {
  const base = apiUrl.replace(/\/+$/, '');
  const qs = new URLSearchParams({ code, state });
  try {
    const res = await fetch(`${base}/auth/token?${qs.toString()}`);
    const payload = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
    if (!res.ok || !payload?.token) {
      return { error: payload?.error ?? `HTTP ${res.status}` };
    }
    return { token: payload.token };
  } catch (e) {
    // eslint-disable-next-line budget-i18n/no-untranslated-string -- developer error text; useSignIn shows a translated notice instead
    return { error: e instanceof Error ? e.message : 'network error' };
  }
}

/**
 * Cloudflare Access native flow: /auth/access/native hands the app a one-time
 * exchange code (`state=access`) on its deep link; this swaps it for the
 * session token. POST keeps the code out of URLs and logs.
 */
export async function exchangeAccessCode(
  apiUrl: string,
  code: string,
): Promise<{ token: string } | { error: string }> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const payload = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
    if (!res.ok || !payload?.token) return { error: payload?.error ?? `HTTP ${res.status}` };
    return { token: payload.token };
  } catch (e) {
    // eslint-disable-next-line budget-i18n/no-untranslated-string -- developer error text; useSignIn shows a translated notice instead
    return { error: e instanceof Error ? e.message : 'network error' };
  }
}
