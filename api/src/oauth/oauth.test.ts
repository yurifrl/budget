import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { httpOnError } from '../core/validate';
import {
  authMiddleware,
  issueAccessToken,
  issueSession,
  mountAuthRoutes,
  provisionUserByEmail,
  requireUser,
  safeReturnTo,
  verifyAccessToken,
  verifySession,
} from '../user';
import { defaultOAuthTtls, createOAuthRouter, grantsRoutes, type OAuthConfig } from './index';
import { escapeHtml } from './consent-page';
import { configureAuth } from '../user';

const SECRET = 's'.repeat(40);
const ISSUER = 'https://api.test';
const RESOURCE = `${ISSUER}/mcp`;
const EMAIL = 'oauth-user@b.com';
const REDIRECT = 'http://localhost:7777/callback';

const cfg: OAuthConfig = { ...defaultOAuthTtls, issuer: ISSUER, resource: RESOURCE, secret: SECRET, devEmail: null };

const AUTH_ON = {
  sessionSecret: SECRET,
  allowedEmails: [EMAIL],
  googleClientId: 'cid',
  googleClientSecret: 'csec',
  apiBaseUrl: ISSUER,
  appOrigin: 'https://app.test',
};

beforeAll(() => {
  configureAuth(AUTH_ON);
});
afterAll(() => {
  configureAuth({ authDisabled: true });
});

function buildTestApp(config: OAuthConfig = cfg) {
  const app = new Hono();
  app.route('/', createOAuthRouter(config));
  app.use('*', authMiddleware);
  app.use('*', requireUser);
  app.route('/', grantsRoutes);
  app.onError(httpOnError);
  app.get('/ping', (c) => c.json({ email: c.get('user')!.email }));
  app.post('/ping', (c) => c.json({ email: c.get('user')!.email }));
  return app;
}

const b64 = (b: Buffer) => b.toString('base64url');
function pkce() {
  const verifier = b64(randomBytes(32));
  return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()) };
}

async function register(app: Hono, over: Record<string, unknown> = {}) {
  const res = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [REDIRECT], ...over }),
  });
  return { res, body: (await res.json()) as Record<string, any> };
}

const cookie = async (email = EMAIL) => `budget_session=${await issueSession(SECRET, email, 600)}`;

function authQuery(clientId: string, challenge: string, over: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    ...over,
  });
}

function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) {
    out[m[1]!] = m[2]!.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  }
  return out;
}

/** register -> authorize (consent page) -> approve; returns the raw code. */
async function authorizeCode(app: Hono, over: Record<string, string> = {}) {
  const { body: client } = await register(app);
  const { verifier, challenge } = pkce();
  const ck = await cookie();
  const page = await app.request(`/oauth/authorize?${authQuery(client.client_id, challenge, over)}`, { headers: { cookie: ck } });
  expect(page.status).toBe(200);
  const fields = hiddenFields(await page.text());
  const post = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: { cookie: ck, origin: ISSUER, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, decision: 'approve' }),
  });
  expect(post.status).toBe(303);
  const loc = new URL(post.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe('st-1');
  expect(loc.searchParams.get('iss')).toBe(ISSUER);
  return { clientId: client.client_id as string, verifier, challenge, code: loc.searchParams.get('code')! };
}

function tokenReq(app: Hono, params: Record<string, string>) {
  return app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

async function fullFlow(app: Hono, over: Record<string, string> = {}) {
  const a = await authorizeCode(app, over);
  const res = await tokenReq(app, {
    grant_type: 'authorization_code', code: a.code, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: a.verifier,
  });
  expect(res.status).toBe(200);
  const tok = (await res.json()) as { access_token: string; refresh_token: string; scope: string; expires_in: number; token_type: string };
  return { ...a, tok };
}

const ping = (app: Hono, token: string, method = 'GET') =>
  app.request('/ping', { method, headers: { authorization: `Bearer ${token}` } });

describe('safeReturnTo', () => {
  it('accepts same-origin relative paths only', () => {
    expect(safeReturnTo('/oauth/authorize?a=1&b=%2F')).toBe('/oauth/authorize?a=1&b=%2F');
    for (const bad of [
      'https://evil.com', '//evil.com', '/\\evil.com', '\\\\evil.com', '/\\/evil.com', 'javascript:alert(1)',
      'evil.com', '', '/ok\r\nSet-Cookie: x=1', '/a\tb', 'http:evil.com', ' /x', '/' + 'a'.repeat(3000),
    ]) {
      expect(safeReturnTo(bad)).toBeNull();
    }
    expect(safeReturnTo(undefined)).toBeNull();
  });
});

describe('token kinds are not interchangeable (no DB)', () => {
  it('session JWT is not an access token and vice versa', async () => {
    const session = await issueSession(SECRET, EMAIL, 60);
    const access = await issueAccessToken(SECRET, { email: EMAIL, scope: 'read', clientId: 'c', grantId: 'g', audience: RESOURCE }, 60);
    expect(await verifyAccessToken(SECRET, session, RESOURCE)).toBeNull();
    expect(await verifySession(SECRET, access)).toBeNull();
    expect(await verifyAccessToken(SECRET, access, RESOURCE)).toMatchObject({ email: EMAIL, grantId: 'g' });
    expect(await verifyAccessToken(SECRET, access, 'https://other/mcp')).toBeNull();
    expect(await verifyAccessToken('x'.repeat(40), access, RESOURCE)).toBeNull();
    const expired = await issueAccessToken(SECRET, { email: EMAIL, scope: 'read', clientId: 'c', grantId: 'g', audience: RESOURCE }, -5);
    expect(await verifyAccessToken(SECRET, expired, RESOURCE)).toBeNull();
  });

  it('escapeHtml neutralises markup', () => {
    expect(escapeHtml(`<script>"x"&'`)).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;');
  });

  it('refuses a weak secret', () => {
    expect(() => createOAuthRouter({ ...cfg, secret: 'short' })).toThrow();
  });
});

describe.skipIf(!dbReady)('oauth authorization server (DB-backed)', () => {
  let app: Hono;
  beforeEach(async () => {
    app = buildTestApp();
    await pool.query(`delete from public.users where email = $1`, [EMAIL]);
    await pool.query(`delete from public.oauth_clients`);
  });

  it('serves discovery documents', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const body = (await (await app.request(path)).json()) as any;
      expect(body.resource).toBe(RESOURCE);
      expect(body.authorization_servers).toEqual([ISSUER]);
    }
    const as = (await (await app.request('/.well-known/oauth-authorization-server')).json()) as any;
    expect(as.issuer).toBe(ISSUER);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(as.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(as.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(as.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
  });

  it('registers public clients and rejects unsafe metadata', async () => {
    const ok = await register(app);
    expect(ok.res.status).toBe(201);
    expect(ok.body.client_id).toMatch(/^c_/);
    expect(ok.body.token_endpoint_auth_method).toBe('none');
    expect((await register(app, { redirect_uris: ['https://app.example/cb'] })).res.status).toBe(201);
    for (const bad of [
      ['http://example.com/cb'], ['javascript:alert(1)'], ['https://a.example/cb#frag'], ['https://u:p@a.example/cb'],
      ['myapp://cb'], [], ['not a url'], ['http://localhost.evil.com/cb'],
      ['data:text/html,x'], ['file:///etc/passwd'], ['about:blank'], ['blob:https://a.example/x'],
      ['cursor://u:p@x/cb'], ['cursor://x/cb#f'], ['com.example.app://cb#f'],
    ]) {
      expect((await register(app, { redirect_uris: bad })).res.status).toBe(400);
    }
    expect((await register(app, { token_endpoint_auth_method: 'client_secret_basic' })).res.status).toBe(400);
    const big = await app.request('/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'x'.repeat(20_000) }),
    });
    expect(big.status).toBe(400);
  });

  it('accepts private-use custom scheme redirect URIs (RFC 8252 7.1)', async () => {
    for (const ok of [
      'cursor://anysphere.cursor-retrieval/oauth/callback', 'vscode://vscode.github-authentication/did-authenticate',
      'windsurf://x/cb', 'claude://cb', 'vscode-insiders://x/cb', 'com.example.app:/oauth2redirect',
    ]) {
      const r = await register(app, { redirect_uris: [ok] });
      expect(r.res.status).toBe(201);
      expect(r.body.redirect_uris).toEqual([ok]);
    }
  });

  it('shows the custom scheme on the consent page and matches the redirect exactly', async () => {
    const uri = 'cursor://anysphere.cursor-retrieval/oauth/callback';
    const { body: client } = await register(app, { redirect_uris: [uri] });
    const { challenge } = pkce();
    const ck = await cookie();
    const res = await app.request(`/oauth/authorize?${authQuery(client.client_id, challenge, { redirect_uri: uri })}`, { headers: { cookie: ck } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('cursor://anysphere.cursor-retrieval');
    const other = await app.request(`/oauth/authorize?${authQuery(client.client_id, challenge, { redirect_uri: `${uri}/x` })}`, { headers: { cookie: ck } });
    expect(other.status).toBe(400);
  });

  it('caps registrations per hour', async () => {
    const capped = buildTestApp({ ...cfg, registerPerHour: 1 });
    expect((await register(capped)).res.status).toBe(201);
    expect((await register(capped)).res.status).toBe(429);
  });

  it('rejects unknown client and mismatching redirect_uri without redirecting', async () => {
    const { challenge } = pkce();
    const ck = await cookie();
    const unknown = await app.request(`/oauth/authorize?${authQuery('c_nope', challenge)}`, { headers: { cookie: ck } });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('location')).toBeNull();
    const { body: client } = await register(app);
    for (const uri of [`${REDIRECT}/`, 'http://localhost:7777/callback2', 'http://localhost:7778/callback', 'https://evil.com/callback', '']) {
      const res = await app.request(`/oauth/authorize?${authQuery(client.client_id, challenge, { redirect_uri: uri })}`, { headers: { cookie: ck } });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('requires PKCE S256 and response_type=code (errors go to the redirect_uri)', async () => {
    const { body: client } = await register(app);
    const { challenge } = pkce();
    const ck = await cookie();
    for (const over of <Record<string, string>[]>[{ code_challenge_method: 'plain' }, { code_challenge: 'short' }, { response_type: 'token' }, { scope: 'admin' }]) {
      const res = await app.request(`/oauth/authorize?${authQuery(client.client_id, challenge, over)}`, { headers: { cookie: ck } });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get('error')).toBeTruthy();
      expect(loc.searchParams.get('code')).toBeNull();
    }
    const missing = authQuery(client.client_id, challenge);
    missing.delete('code_challenge_method');
    const res = await app.request(`/oauth/authorize?${missing}`, { headers: { cookie: ck } });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('sends a logged-out browser through /auth/google with a same-origin return_to', async () => {
    const { body: client } = await register(app);
    const { challenge } = pkce();
    const q = authQuery(client.client_id, challenge);
    const res = await app.request(`/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('/auth/google?return_to=')).toBe(true);
    const returnTo = new URL(loc, ISSUER).searchParams.get('return_to')!;
    expect(returnTo).toBe(`/oauth/authorize?${q}`);
    expect(safeReturnTo(returnTo)).toBe(returnTo);
  });

  it('escapes client_name and redirect host on the consent page, and sets anti-framing headers', async () => {
    const evil = '<img src=x onerror=alert(1)>"&';
    const { body: client } = await register(app, { client_name: evil });
    const { challenge } = pkce();
    const res = await app.request(`/oauth/authorize?${authQuery(client.client_id, challenge)}`, { headers: { cookie: await cookie() } });
    const html = await res.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;');
    expect(html).toContain('localhost:7777');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('protects the consent POST against CSRF', async () => {
    const { body: client } = await register(app);
    const { challenge } = pkce();
    const ck = await cookie();
    const fields = hiddenFields(await (await app.request(`/oauth/authorize?${authQuery(client.client_id, challenge)}`, { headers: { cookie: ck } })).text());
    const post = (f: Record<string, string>, headers: Record<string, string>) =>
      app.request('/oauth/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ ...f, decision: 'approve' }),
      });
    expect((await post(fields, { cookie: ck, origin: 'https://evil.example' })).status).toBe(403);
    // browsers send Origin: null under no-referrer; never accepted
    expect((await post(fields, { cookie: ck, origin: 'null' })).status).toBe(403);
    expect((await post({ ...fields, csrf: '' }, { cookie: ck, origin: ISSUER })).status).toBe(403);
    expect((await post({ ...fields, csrf: fields.csrf!.replace(/(.)$/, (ch) => (ch === 'A' ? 'B' : 'A')) }, { cookie: ck, origin: ISSUER })).status).toBe(403);
    // tampering with a bound field (scope) invalidates the token
    expect((await post({ ...fields, scope: 'read' }, { cookie: ck, origin: ISSUER })).status).toBe(403);
    // a session of a non-allowlisted user is refused
    expect((await post(fields, { cookie: await cookie('intruder@b.com'), origin: ISSUER })).status).toBe(401);
    // no session at all
    expect((await post(fields, { origin: ISSUER })).status).toBe(401);
    // an expired token
    const expired = `1.${fields.csrf!.split('.')[1]}`;
    expect((await post({ ...fields, csrf: expired }, { cookie: ck, origin: ISSUER })).status).toBe(403);
  });

  it('consent page sends Referrer-Policy same-origin; POST with the real issuer Origin succeeds', async () => {
    const { body: client } = await register(app);
    const { challenge } = pkce();
    const ck = await cookie();
    const page = await app.request(`/oauth/authorize?${authQuery(client.client_id, challenge)}`, { headers: { cookie: ck } });
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    const fields = hiddenFields(await page.text());
    const res = await app.request('/oauth/authorize', {
      method: 'POST', headers: { cookie: ck, origin: ISSUER, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, decision: 'approve' }),
    });
    expect(res.status).toBe(303);
  });

  it('denial redirects with access_denied and issues no code', async () => {
    const { body: client } = await register(app);
    const { challenge } = pkce();
    const ck = await cookie();
    const fields = hiddenFields(await (await app.request(`/oauth/authorize?${authQuery(client.client_id, challenge)}`, { headers: { cookie: ck } })).text());
    const res = await app.request('/oauth/authorize', {
      method: 'POST', headers: { cookie: ck, origin: ISSUER, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, decision: 'deny' }),
    });
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('code')).toBeNull();
    expect((await pool.query('select count(*)::int as n from public.oauth_codes')).rows[0].n).toBe(0);
  });

  it('happy path: authorize -> token with PKCE; access token acts as the user', async () => {
    const { tok, code } = await fullFlow(app);
    expect(tok.token_type).toBe('Bearer');
    expect(tok.expires_in).toBe(3600);
    expect(tok.scope).toBe('read write');
    const res = await ping(app, tok.access_token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: EMAIL });
    // tokens and codes are stored only as hashes
    const dump = JSON.stringify([
      (await pool.query('select * from public.oauth_codes')).rows,
      (await pool.query('select * from public.oauth_refresh_tokens')).rows,
    ]);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(tok.refresh_token);
    expect(await ping(app, tok.access_token, 'POST')).toHaveProperty('status', 200);
  });

  it('read-only grants cannot call mutating methods', async () => {
    const { tok } = await fullFlow(app, { scope: 'read' });
    expect(tok.scope).toBe('read');
    expect((await ping(app, tok.access_token)).status).toBe(200);
    expect((await ping(app, tok.access_token, 'POST')).status).toBe(403);
  });

  it('rejects a wrong PKCE verifier', async () => {
    const a = await authorizeCode(app);
    const res = await tokenReq(app, {
      grant_type: 'authorization_code', code: a.code, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: pkce().verifier,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('invalid_grant');
    // code is burned: the right verifier no longer works
    const retry = await tokenReq(app, {
      grant_type: 'authorization_code', code: a.code, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: a.verifier,
    });
    expect(retry.status).toBe(400);
  });

  it('rejects a mismatched redirect_uri or client at the token endpoint', async () => {
    const a = await authorizeCode(app);
    const other = (await register(app)).body.client_id as string;
    const wrongRedirect = await tokenReq(app, {
      grant_type: 'authorization_code', code: a.code, client_id: a.clientId, redirect_uri: `${REDIRECT}/x`, code_verifier: a.verifier,
    });
    expect(wrongRedirect.status).toBe(400);
    const b = await authorizeCode(app);
    const wrongClient = await tokenReq(app, {
      grant_type: 'authorization_code', code: b.code, client_id: other, redirect_uri: REDIRECT, code_verifier: b.verifier,
    });
    expect(wrongClient.status).toBe(400);
    expect((await tokenReq(app, { grant_type: 'authorization_code', code: 'x', client_id: 'c_nope', redirect_uri: REDIRECT, code_verifier: a.verifier })).status).toBe(401);
  });

  it('codes are one-time: reuse is rejected and revokes the grant and its tokens', async () => {
    const a = await authorizeCode(app);
    const params = { grant_type: 'authorization_code', code: a.code, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: a.verifier };
    const first = await tokenReq(app, params);
    expect(first.status).toBe(200);
    const tok = (await first.json()) as any;
    expect((await ping(app, tok.access_token)).status).toBe(200);
    expect((await tokenReq(app, params)).status).toBe(400);
    expect((await ping(app, tok.access_token)).status).toBe(401);
    expect((await tokenReq(app, { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: a.clientId })).status).toBe(400);
  });

  it('concurrent redemption of one code yields exactly one success', async () => {
    const a = await authorizeCode(app);
    const params = { grant_type: 'authorization_code', code: a.code, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: a.verifier };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => tokenReq(app, params)));
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  });

  it('rejects an expired code', async () => {
    const a = await authorizeCode(app);
    await pool.query(`update public.oauth_codes set expires_at = now() - interval '1 second'`);
    const res = await tokenReq(app, {
      grant_type: 'authorization_code', code: a.code, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: a.verifier,
    });
    expect(res.status).toBe(400);
  });

  it('rotates refresh tokens; reusing a rotated one revokes the grant and its access tokens', async () => {
    const { tok, clientId } = await fullFlow(app);
    const r1 = await tokenReq(app, { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
    expect(r1.status).toBe(200);
    const t1 = (await r1.json()) as any;
    expect(t1.refresh_token).not.toBe(tok.refresh_token);
    expect((await ping(app, t1.access_token)).status).toBe(200);

    // replay of the rotated token
    const replay = await tokenReq(app, { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId });
    expect(replay.status).toBe(400);
    // whole grant is dead: newest refresh token and both access tokens fail
    expect((await tokenReq(app, { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId })).status).toBe(400);
    expect((await ping(app, t1.access_token)).status).toBe(401);
    expect((await ping(app, tok.access_token)).status).toBe(401);
  });

  it('enforces the absolute grant lifetime on refresh and on access tokens', async () => {
    const { tok, clientId } = await fullFlow(app);
    await pool.query(`update public.oauth_grants set expires_at = now() - interval '1 second'`);
    expect((await tokenReq(app, { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId })).status).toBe(400);
    expect((await ping(app, tok.access_token)).status).toBe(401);
  });

  it('refresh with another client id fails', async () => {
    const { tok } = await fullFlow(app);
    const other = (await register(app)).body.client_id as string;
    expect((await tokenReq(app, { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: other })).status).toBe(400);
  });

  it('revokes a grant via its refresh token', async () => {
    const { tok, clientId } = await fullFlow(app);
    const res = await app.request('/oauth/revoke', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tok.refresh_token, client_id: clientId }),
    });
    expect(res.status).toBe(200);
    expect((await ping(app, tok.access_token)).status).toBe(401);
    expect((await tokenReq(app, { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId })).status).toBe(400);
  });

  it('revokes a grant via its access token (JSON body) and tolerates junk tokens', async () => {
    const { tok } = await fullFlow(app);
    const junk = await app.request('/oauth/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope' }),
    });
    expect(junk.status).toBe(200);
    expect((await ping(app, tok.access_token)).status).toBe(200);
    const res = await app.request('/oauth/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok.access_token }),
    });
    expect(res.status).toBe(200);
    expect((await ping(app, tok.access_token)).status).toBe(401);
  });

  it('lists only the caller\'s active grants and revokes only their own (revoke kills the access token)', async () => {
    const { tok, clientId } = await fullFlow(app);
    const ck = await cookie();
    const list = await app.request('/oauth/grants', { headers: { cookie: ck } });
    expect(list.status).toBe(200);
    const grants = (await list.json()) as any[];
    expect(grants).toHaveLength(1);
    expect(grants[0].client_name).toBe('Test Client');
    expect(Array.isArray(grants[0].scopes)).toBe(true);
    expect(grants[0].scopes.length).toBeGreaterThan(0);
    expect(typeof grants[0].created_at).toBe('string');
    expect(typeof grants[0].expires_at).toBe('string');
    expect(Object.keys(grants[0]).sort()).toEqual(['client_name', 'created_at', 'expires_at', 'id', 'last_used_at', 'scopes']);

    // another user's grant: invisible in the list and a 404 on revoke
    const other = await provisionUserByEmail('grants-other@b.com');
    const otherGrant = await pool.query<{ id: string }>(
      `insert into public.oauth_grants (id, user_id, client_id, scope, resource, expires_at)
       values (gen_random_uuid(), $1, $2, 'read', $3, now() + interval '1 day') returning id`,
      [other.id, clientId, RESOURCE],
    );
    const otherId = otherGrant.rows[0]!.id;
    expect(((await (await app.request('/oauth/grants', { headers: { cookie: ck } })).json()) as any[]).map((g) => g.id)).toEqual([grants[0].id]);
    const foreign = await app.request(`/oauth/grants/${otherId}`, { method: 'DELETE', headers: { cookie: ck } });
    expect(foreign.status).toBe(404);
    const still = await pool.query('select revoked_at from public.oauth_grants where id = $1', [otherId]);
    expect(still.rows[0].revoked_at).toBeNull();
    expect((await app.request('/oauth/grants/nope', { method: 'DELETE', headers: { cookie: ck } })).status).toBe(400);

    // own grant: token works, revoke, token stops working, list is empty, repeat is 404
    expect((await ping(app, tok.access_token)).status).toBe(200);
    expect((await app.request(`/oauth/grants/${grants[0].id}`, { method: 'DELETE', headers: { cookie: ck } })).status).toBe(200);
    expect((await ping(app, tok.access_token)).status).toBe(401);
    expect((await tokenReq(app, { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId })).status).toBe(400);
    expect(await (await app.request('/oauth/grants', { headers: { cookie: ck } })).json()).toEqual([]);
    expect((await app.request(`/oauth/grants/${grants[0].id}`, { method: 'DELETE', headers: { cookie: ck } })).status).toBe(404);
    await pool.query('delete from public.users where id = $1', [other.id]);
  });

  it('accepts JSON token requests and rejects unknown grant types', async () => {
    const a = await authorizeCode(app);
    const res = await app.request('/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: a.code, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: a.verifier }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const bad = await tokenReq(app, { grant_type: 'password', client_id: a.clientId });
    expect(((await bad.json()) as any).error).toBe('unsupported_grant_type');
  });

  it('session and access tokens are not interchangeable at the gate', async () => {
    const { tok } = await fullFlow(app);
    // access token as a login cookie: refused
    const asCookie = await app.request('/ping', { headers: { cookie: `budget_session=${tok.access_token}` } });
    expect(asCookie.status).toBe(401);
    // access token where session auth is expected (/auth/me style): currentUser rejects it
    // currentUser is deliberately not on the user barrel (klv9: pre-gate routes must go through rejectUnlessActiveSession).
    // eslint-disable-next-line import/no-restricted-paths
    const { currentUser } = await import('../user/authz');
    const probe = new Hono();
    probe.get('/who', async (c) => c.json({ u: await currentUser(c) }));
    const who = await probe.request('/who', { headers: { authorization: `Bearer ${tok.access_token}` } });
    expect(((await who.json()) as any).u).toBeNull();
    // session JWT as a bearer keeps working as before (native app), but is no access token
    const session = await issueSession(SECRET, EMAIL, 60);
    expect((await ping(app, session)).status).toBe(200);
    expect(await verifyAccessToken(SECRET, session, RESOURCE)).toBeNull();
    // forged access token for a non-existent grant
    const forged = await issueAccessToken(SECRET, { email: EMAIL, scope: 'read write', clientId: 'c', grantId: crypto.randomUUID(), audience: RESOURCE }, 60);
    expect((await ping(app, forged)).status).toBe(401);
    // allowlist removal kills the token
    configureAuth({ ...AUTH_ON, allowedEmails: ['someone-else@b.com'] });
    expect((await ping(app, tok.access_token)).status).toBe(401);
    configureAuth(AUTH_ON);
  });

  it('/auth/me resolves an access token to its email (CLI whoami)', async () => {
    const { tok } = await fullFlow(app);
    const me = new Hono();
    mountAuthRoutes(me);
    const res = await me.request('/auth/me', { headers: { authorization: `Bearer ${tok.access_token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: EMAIL });
    expect((await me.request('/auth/me')).status).toBe(401);
  });

  it('dev mode (auth disabled): authorize works without login via the dev user', async () => {
    configureAuth({ ...AUTH_ON, authDisabled: true, googleClientId: '', allowedEmails: [] });
    try {
      const dev = buildTestApp({ ...cfg, devEmail: 'dev@localhost' });
      const { body: client } = await register(dev);
      const { challenge } = pkce();
      const res = await dev.request(`/oauth/authorize?${authQuery(client.client_id, challenge)}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('dev@localhost');
    } finally {
      configureAuth(AUTH_ON);
    }
  });

  it('with a dev email configured but auth ENABLED, a missing session still requires login', async () => {
    const dev = buildTestApp({ ...cfg, devEmail: 'dev@localhost' });
    const { body: client } = await register(dev);
    const { challenge } = pkce();
    const res = await dev.request(`/oauth/authorize?${authQuery(client.client_id, challenge)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toStartWith('/auth/google?return_to=');
    // the consent POST cannot be served as the dev user either
    const fields = { client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'read write', state: '', csrf: '9999999999.x', decision: 'approve' };
    const post = await dev.request('/oauth/authorize', {
      method: 'POST', headers: { origin: ISSUER, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
    });
    expect(post.status).toBe(401);
    expect((await pool.query('select count(*)::int as n from public.oauth_grants')).rows[0].n).toBe(0);
  });
});

describe('Google login return_to hand-off', () => {
  async function authApp() {
    mock.module('../user/google', () => ({
      googleConfigured: () => true,
      googleAuthUrl: (redirect: string, state: string) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ redirect_uri: redirect, state })}`,
      exchangeCode: async () => ({ email: EMAIL, emailVerified: true, sub: 'sub-oauth' }),
    }));
    const { mountAuthRoutes } = await import('../user/authz?return-to-' + Math.random());
    const a = new Hono();
    mountAuthRoutes(a);
    return a;
  }

  it('stores only a validated return_to; rejects open-redirect attempts', async () => {
    const a = await authApp();
    const good = await a.request('/auth/google?return_to=' + encodeURIComponent('/oauth/authorize?x=1'));
    expect(good.status).toBe(302);
    expect(good.headers.get('set-cookie')).toContain('g_return=');
    for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:1']) {
      const res = await a.request('/auth/google?return_to=' + encodeURIComponent(bad));
      expect(res.status).toBe(302);
      const setCookie = res.headers.get('set-cookie') ?? '';
      // either never set, or explicitly cleared (empty value / expired)
      const set = /g_return=([^;]*)/.exec(setCookie);
      expect(set === null || set[1] === '').toBe(true);
    }
  });

  it('callback returns to the validated path, else to the app; no return_to = unchanged behavior', async () => {
    if (!dbReady) return;
    await pool.query(`delete from public.users where email = $1`, [EMAIL]);
    const a = await authApp();
    const cb = (ret?: string) =>
      a.request('/auth/google/callback?state=s1&code=good', {
        headers: { cookie: `g_state=s1${ret ? `; g_return=${encodeURIComponent(ret)}` : ''}` },
      });
    const ok = await cb('/oauth/authorize?x=1');
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe(`${ISSUER}/oauth/authorize?x=1`);
    expect(ok.headers.get('set-cookie')).toContain('budget_session=');
    expect((await cb()).headers.get('location')).toBe('https://app.test');
    // a tampered cookie value is re-validated and ignored
    const evil = await a.request('/auth/google/callback?state=s1&code=good', {
      headers: { cookie: 'g_state=s1; g_return=//evil.com' },
    });
    expect(evil.headers.get('location')).toBe('https://app.test');
  });
});
