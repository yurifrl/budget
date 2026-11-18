import type { Context, Hono, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { issueSession, verifyAccessToken, verifySession } from './auth';
import { authConfig } from './config';
import { googleConfigured, googleAuthUrl, exchangeCode } from './google';
import { errorResponse } from '../core/validate';
import { safeReturnTo } from './return-to';
import type { SessionPrincipal } from './types';
import { EmailAlreadyProvisionedError, isGrantActive, resolveOrCreateSessionUser } from './store';

const STATE_COOKIE = 'g_state';
const RETURN_COOKIE = 'g_return';

// Config is injected by the entrypoint (user/config.ts); nothing here reads env.
const COOKIE = () => authConfig().cookieName;
const secret = () => authConfig().sessionSecret;
const cookieDomain = () => authConfig().cookieDomain;
const appBaseUrl = () => authConfig().appOrigin;
export const apiBaseUrl = () => authConfig().apiBaseUrl;
const ttlSeconds = () => authConfig().sessionTtlDays * 86400;

/** Machine-to-machine bearer token for agent clients (hermes); unset = disabled. */
export function serviceTokenMatches(candidate: string): boolean {
  const token = authConfig().serviceToken;
  if (!token || candidate.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

/** Email is authorized when it appears in the allowlist (case-insensitive). */
export function isAllowed(email: string): boolean {
  return authConfig().allowedEmails.includes(email.toLowerCase());
}

/**
 * Auth is bypassed only when the entrypoint says so (`authDisabled`): local
 * dev with the explicit AUTH_DISABLED_OK=1 opt-in and no auth configured.
 */
export function authDisabled(): boolean {
  return authConfig().authDisabled;
}

/** Session cookie only (browser flows: OAuth consent). Never a bearer. */
export async function cookieSessionUser(c: Context): Promise<{ email: string } | null> {
  const token = getCookie(c, COOKIE());
  if (!token) return null;
  const claims = await verifySession(secret(), token);
  return claims && isAllowed(claims.email) ? claims : null;
}

/** Audience every OAuth access token is minted for: the MCP resource URL. */
export const oauthResourceUrl = () => `${apiBaseUrl()}/mcp`;

/**
 * Resolve the signed-in user from an httpOnly session cookie (web) or a
 * Bearer session token (native apps — their fetches cannot see the cookie
 * domain). Session tokens only: OAuth access tokens are NOT accepted here
 * (see principalFromRequest), so pre-gate callers keep their exact behavior.
 */
export async function currentUser(c: Context): Promise<{ email: string } | null> {
  const auth = c.req.header('Authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const token = bearer || getCookie(c, COOKIE());
  if (!token) return null;
  const claims = await verifySession(secret(), token);
  if (!claims || !isAllowed(claims.email)) return null;
  return claims;
}

/**
 * The gate's principal: a session (as currentUser) or, from the
 * Authorization header ONLY, an OAuth access token (kind 'access', audience
 * = the MCP resource) whose grant is still live. Access tokens are never
 * honoured from the cookie.
 */
export async function principalFromRequest(c: Context): Promise<SessionPrincipal | null> {
  const session = await currentUser(c);
  if (session) return session;
  return accessPrincipal(c.req.header('Authorization'));
}

/**
 * OAuth access token ONLY (from an Authorization header value): signature,
 * expiry, kind 'access', audience = the MCP resource, allow-listed email and
 * a live grant. Used by the MCP endpoint, which accepts nothing else.
 */
export async function accessPrincipal(authorization: string | undefined | null): Promise<SessionPrincipal | null> {
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (!bearer) return null;
  const access = await verifyAccessToken(secret(), bearer, oauthResourceUrl());
  if (!access || !isAllowed(access.email)) return null;
  if (!(await isGrantActive(access.grantId, access.email))) return null;
  return { email: access.email, scope: access.scope, grantId: access.grantId };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  if (authDisabled()) return next();
  const claims = await principalFromRequest(c);
  if (!claims) {
    // A bearer that is not a valid session JWT is deferred to requireUser's
    // service lane (D-06): requireUser is the sole bearer authority and
    // fails closed. No credentials at all → 401 at the gate as today.
    const auth = c.req.header('Authorization');
    if (auth?.startsWith('Bearer ')) return next();
    return errorResponse(c, 401, 'unauthorized');
  }
  // Access tokens carry a scope: without `write` the grant is read-only.
  if (claims.scope !== undefined && !SAFE_METHODS.has(c.req.method) && !claims.scope.split(' ').includes('write')) {
    return errorResponse(c, 403, 'insufficient_scope', 'insufficient_scope');
  }
  // Principal claims feed the identity seam: requireUser resolves the
  // DB-authoritative user row from these per request (D-05).
  c.set('principal', claims);
  return next();
};

export function mountAuthRoutes(app: Hono): void {
  app.get('/auth/me', async (c) => {
    // Mirror authMiddleware: unconfigured local dev runs open, so the probe
    // must succeed or every client is gated out of an open API.
    if (authDisabled()) return c.json({ email: 'dev@localhost' });
    // Session OR OAuth access token (the CLI's `whoami`); both resolve to an email.
    const user = await principalFromRequest(c);
    return user ? c.json({ email: user.email }) : errorResponse(c, 401, 'unauthorized');
  });

  app.get('/auth/google', (c) => {
    if (!googleConfigured()) return errorResponse(c, 503, 'google not configured');
    const state = crypto.randomUUID();
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    // Optional same-origin return path (OAuth consent hand-off). Validated
    // here and again at the callback; absent/invalid → the cookie is cleared
    // so a stale one can never redirect a plain login.
    const returnTo = safeReturnTo(c.req.query('return_to'));
    if (returnTo) {
      setCookie(c, RETURN_COOKIE, returnTo, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600 });
    } else {
      deleteCookie(c, RETURN_COOKIE, { path: '/' });
    }
    return c.redirect(googleAuthUrl(`${apiBaseUrl()}/auth/google/callback`, state));
  });

  app.get('/auth/google/callback', async (c) => {
    const state = c.req.query('state');
    const cookieState = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: '/' });
    const returnTo = safeReturnTo(getCookie(c, RETURN_COOKIE));
    deleteCookie(c, RETURN_COOKIE, { path: '/' });
    if (!state || state !== cookieState) return c.text('Login expired, try again.', 400);

    const code = c.req.query('code');
    if (!code) return c.redirect(appBaseUrl());

    const id = await exchangeCode(code, `${apiBaseUrl()}/auth/google/callback`);
    if (!id || !id.emailVerified) return c.text('Could not verify your Google account.', 401);
    if (!isAllowed(id.email)) return c.text('Not authorized.', 403);

    // Sign-in-time identity capture (USER-01): the fully verified Google
    // identity lands google_sub + name now; per-request resolution remains
    // the backstop for old cookies that carry no sub. A cross-email sub
    // collision (A5) rejects here rather than silently merging rows.
    try {
      await resolveOrCreateSessionUser(id.email, { sub: id.sub, name: id.name });
    } catch (err) {
      if (err instanceof EmailAlreadyProvisionedError) return c.text('Email already provisioned.', 403);
      throw err;
    }

    setCookie(c, COOKIE(), await issueSession(secret(), id.email, ttlSeconds()), {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      domain: cookieDomain(),
      path: '/',
      maxAge: ttlSeconds(),
    });
    return c.redirect(returnTo ? `${apiBaseUrl()}${returnTo}` : appBaseUrl());
  });

  app.get('/auth/logout', (c) => {
    deleteCookie(c, COOKIE(), { path: '/', domain: cookieDomain() });
    return c.redirect(appBaseUrl());
  });

  /**
   * Native sign-in start. Native apps cannot hold the httpOnly session cookie,
   * so the flow ends by handing the app a session token through a deep link.
   * The authorization code first lands on this server's https callback
   * (the redirect_uri registered in Google Cloud) and is forwarded to the app
   * together with an HMAC over the state nonce — the app then exchanges
   * code+state at /auth/token, so it only ever accepts codes minted for a
   * login THIS server started (no code-forgery via a hand-crafted start URL).
   * The app URL allowlist (exp:// for Expo Go dev, budgetapp:// for the
   * standalone build) keeps the forwarding hop from becoming an open redirect.
   * PKCE would be the next hardening step if this ever grows beyond a
   * personal allowlisted app.
   */
  app.get('/auth/google/native', (c) => {
    if (!googleConfigured()) return errorResponse(c, 503, 'google not configured');
    const appUri = c.req.query('redirect_uri') ?? '';
    const schemes = authConfig().nativeRedirectSchemes;
    if (!schemes.some((p) => appUri.toLowerCase().startsWith(p.toLowerCase()))) {
      return c.text(`redirect_uri must be an ${schemes.join(' or ')} URL`, 400);
    }
    const state = `${appUri}|${crypto.randomUUID()}`;
    return c.redirect(googleAuthUrl(`${apiBaseUrl()}/auth/google/native/callback`, state));
  });

  app.get('/auth/google/native/callback', (c) => {
    const raw = c.req.query('state') ?? '';
    const sep = raw.lastIndexOf('|');
    const appUri = sep >= 0 ? raw.slice(0, sep) : '';
    if (!appUri) return c.text('Login expired, try again.', 400);
    const nonce = sep >= 0 ? raw.slice(sep + 1) : '';
    const code = c.req.query('code');
    if (!code) return c.redirect(`${appUri}?error=cancelled`);
    const qs = new URLSearchParams({ code, state: `${nonce}.${exchangeTicket(nonce)}` });
    return c.redirect(`${appUri}?${qs.toString()}`);
  });

  /** Exchange a native-flow code for a stateless session token (Bearer auth). */
  app.get('/auth/token', async (c) => {
    const state = c.req.query('state') ?? '';
    const sep = state.lastIndexOf('.');
    const expected = sep < 0 ? null : Buffer.from(exchangeTicket(state.slice(0, sep)));
    const got = sep < 0 ? null : Buffer.from(state.slice(sep + 1));
    if (!expected || !got || expected.length !== got.length || !timingSafeEqual(expected, got)) {
      return errorResponse(c, 400, 'login expired, try again');
    }
    const id = await exchangeCode(c.req.query('code') ?? '', `${apiBaseUrl()}/auth/google/native/callback`);
    if (!id || !id.emailVerified) return errorResponse(c, 401, 'could not verify your Google account');
    if (!isAllowed(id.email)) return errorResponse(c, 403, 'not authorized');
    try {
      await resolveOrCreateSessionUser(id.email, { sub: id.sub, name: id.name });
    } catch (err) {
      if (err instanceof EmailAlreadyProvisionedError) return errorResponse(c, 403, 'email already provisioned');
      throw err;
    }
    return c.json({ token: await issueSession(secret(), id.email, ttlSeconds()), email: id.email });
  });
}

/**
 * HMAC ticket binding a native login's state nonce to this server. Minted in
 * the redirect the app receives and re-checked at /auth/token, so the exchange
 * endpoint only accepts codes minted for a login this server started. The
 * sha256/base64url shape must match exactly on both sides — hence one name.
 */
function exchangeTicket(nonce: string): string {
  return createHmac('sha256', secret()).update(nonce).digest('base64url');
}
