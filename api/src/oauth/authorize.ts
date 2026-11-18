import { Hono, type Context } from 'hono';

import { authDisabled, cookieSessionUser, isAllowed, resolveOrCreateSessionUser, safeReturnTo } from '../user';
import { CHALLENGE_RE, hmacBase64Url, safeEqual } from './crypto';
import { DEFAULT_SCOPE, SCOPES, type OAuthConfig } from './config';
import { renderConsent, renderError } from './consent-page';
import { readParams, BodyError } from './http';
import { createGrantAndCode, getClient, type OAuthClient } from './store';

const CONSENT_TTL_SECONDS = 600;

interface AuthRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  codeChallenge: string;
  resource: string;
}

type Parsed =
  | { ok: true; req: AuthRequest; client: OAuthClient }
  /** Cannot trust redirect_uri: show an error page, never redirect. */
  | { ok: false; page: string }
  /** redirect_uri is trusted: report the error to it. */
  | { ok: false; redirect: { uri: string; state: string; error: string; description: string } };

function pageHeaders(c: Context) {
  c.header('Cache-Control', 'no-store');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'same-origin');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
}

function redirectWith(uri: string, issuer: string, params: Record<string, string>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== '') u.searchParams.set(k, v);
  u.searchParams.set('iss', issuer);
  return u.toString();
}

/** Validate an authorization request (query on GET, form on POST) against the registry. */
async function parseRequest(p: Record<string, string>, cfg: OAuthConfig): Promise<Parsed> {
  const client = await getClient(p.client_id ?? '');
  if (!client) return { ok: false, page: 'Unknown client.' };
  const redirectUri = p.redirect_uri ?? '';
  // Exact string match against the registered list; never prefix/host/normalized.
  if (!client.redirectUris.includes(redirectUri)) return { ok: false, page: 'redirect_uri is not registered for this client.' };

  const state = (p.state ?? '').slice(0, 512);
  const fail = (error: string, description: string): Parsed => ({
    ok: false,
    redirect: { uri: redirectUri, state, error, description },
  });
  if (p.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  if (p.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
  const codeChallenge = p.code_challenge ?? '';
  if (!CHALLENGE_RE.test(codeChallenge)) return fail('invalid_request', 'code_challenge is missing or malformed');

  const requested = (p.scope ?? DEFAULT_SCOPE).split(/\s+/).filter(Boolean);
  if (requested.length === 0 || !requested.every((s) => (SCOPES as readonly string[]).includes(s))) {
    return fail('invalid_scope', 'unsupported scope');
  }
  const scope = [...new Set(requested)].join(' ');
  if (p.resource !== undefined && p.resource !== cfg.resource) return fail('invalid_target', 'unknown resource');

  return { ok: true, client, req: { clientId: client.clientId, redirectUri, state, scope, codeChallenge, resource: cfg.resource } };
}

function csrfToken(cfg: OAuthConfig, email: string, r: AuthRequest, exp: number): string {
  const mac = hmacBase64Url(cfg.secret, JSON.stringify(['consent', email, r.clientId, r.redirectUri, r.codeChallenge, r.state, r.scope, exp]));
  return `${exp}.${mac}`;
}

function csrfValid(cfg: OAuthConfig, email: string, r: AuthRequest, token: string): boolean {
  const dot = token.indexOf('.');
  const exp = Number(token.slice(0, dot));
  if (dot < 1 || !Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(token, csrfToken(cfg, email, r, exp));
}

/** Resolve who is approving: the session cookie, or the dev identity when auth is off. */
async function approver(c: Context, cfg: OAuthConfig): Promise<string | null> {
  const session = await cookieSessionUser(c);
  if (session) return session.email;
  if (cfg.devEmail && authDisabled()) return cfg.devEmail;
  return null;
}

export function authorizeRoutes(cfg: OAuthConfig): Hono {
  const app = new Hono();

  app.get('/oauth/authorize', async (c) => {
    pageHeaders(c);
    const parsed = await parseRequest(c.req.query(), cfg);
    if (!parsed.ok) {
      if ('page' in parsed) return c.html(renderError(parsed.page), 400);
      const r = parsed.redirect;
      return c.redirect(redirectWith(r.uri, cfg.issuer, { error: r.error, error_description: r.description, state: r.state }));
    }
    const email = await approver(c, cfg);
    if (!email) {
      // Reuse the existing Google login; it returns here via a validated
      // same-origin relative return_to.
      const url = new URL(c.req.url);
      const returnTo = safeReturnTo(`${url.pathname}${url.search}`);
      if (!returnTo) return c.html(renderError('Request too large to resume after login.'), 400);
      return c.redirect(`/auth/google?return_to=${encodeURIComponent(returnTo)}`);
    }
    const exp = Math.floor(Date.now() / 1000) + CONSENT_TTL_SECONDS;
    const q = parsed.req;
    return c.html(
      renderConsent({
        clientName: parsed.client.clientName,
        redirectUri: q.redirectUri,
        scopes: q.scope.split(' '),
        email,
        action: '/oauth/authorize',
        fields: {
          client_id: q.clientId,
          redirect_uri: q.redirectUri,
          response_type: 'code',
          code_challenge: q.codeChallenge,
          code_challenge_method: 'S256',
          scope: q.scope,
          state: q.state,
          csrf: csrfToken(cfg, email, q, exp),
        },
      }),
    );
  });

  app.post('/oauth/authorize', async (c) => {
    pageHeaders(c);
    // CSRF layer 1: a browser always sends Origin on cross-site POST.
    const origin = c.req.header('Origin');
    if (origin !== undefined && origin !== new URL(cfg.issuer).origin) return c.html(renderError('Cross-origin request refused.'), 403);
    let form: Record<string, string>;
    try {
      form = await readParams(c);
    } catch (err) {
      return c.html(renderError(err instanceof BodyError ? err.message : 'bad request'), 400);
    }
    const parsed = await parseRequest(form, cfg);
    if (!parsed.ok) {
      if ('page' in parsed) return c.html(renderError(parsed.page), 400);
      const r = parsed.redirect;
      return c.redirect(redirectWith(r.uri, cfg.issuer, { error: r.error, error_description: r.description, state: r.state }), 303);
    }
    const email = await approver(c, cfg);
    if (!email) return c.html(renderError('Your session expired. Start again.'), 401);
    // CSRF layer 2: token bound to this user and this exact request.
    if (!csrfValid(cfg, email, parsed.req, form.csrf ?? '')) return c.html(renderError('Invalid or expired form. Start again.'), 403);

    const q = parsed.req;
    if (form.decision !== 'approve') {
      return c.redirect(redirectWith(q.redirectUri, cfg.issuer, { error: 'access_denied', state: q.state }), 303);
    }
    if (!cfg.devEmail || !authDisabled()) {
      if (!isAllowed(email)) return c.html(renderError('Not authorized.'), 403);
    }
    const user = await resolveOrCreateSessionUser(email);
    if (user.status !== 'active') return c.html(renderError('Account disabled.'), 403);
    const code = await createGrantAndCode({
      userId: user.id,
      clientId: q.clientId,
      scope: q.scope,
      resource: q.resource,
      redirectUri: q.redirectUri,
      codeChallenge: q.codeChallenge,
      codeTtlSeconds: cfg.codeTtlSeconds,
      grantTtlSeconds: cfg.grantTtlSeconds,
    });
    return c.redirect(redirectWith(q.redirectUri, cfg.issuer, { code, state: q.state }), 303);
  });

  return app;
}
