/**
 * Sign in with Cloudflare Access, end to end through the composed app
 * (buildApp, real auth gate, real DB): a FAKE JWKS (local key pair, injected
 * fetch) stands in for Cloudflare. Covers /auth/access (web cookie),
 * /auth/access/native + /auth/exchange (native token), /auth/providers,
 * the OAuth consent hand-off, the Access-only allow-list rule and the
 * revocation path (users.status).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { authProviders } from '@shared/contracts/user/providers';
import { buildApp } from './app';
import { pool } from './core/db';
import { dbReady } from './core/test-gate';
import { defaultOAuthTtls } from './oauth';
import { AUD, claims, fakeJwks, makeKey, signRs256, TEAM, type TestKey } from './user/access-test-kit';
import { issueSession } from './user/auth';
import { configureAuth, type AuthConfig } from './user/config';

const SECRET = 'a'.repeat(40);
const API = 'https://api.test';
const APP = 'https://app.test';
const PERSON = 'access-person@accesssignin.test';
const OTHER = 'access-other@accesssignin.test';

let key: TestKey;
let jwks: ReturnType<typeof fakeJwks>;

const ACCESS_ON = (): Partial<AuthConfig> => ({
  sessionSecret: SECRET,
  apiBaseUrl: API,
  appOrigin: APP,
  accessTeamDomain: TEAM,
  accessAud: [AUD],
  accessFetch: jwks.fetch,
  allowedEmails: [],
  googleClientId: '',
  googleClientSecret: '',
});

const app = () =>
  buildApp({
    appOrigin: APP,
    version: 't',
    oauth: { ...defaultOAuthTtls, issuer: API, resource: `${API}/mcp`, secret: SECRET, devEmail: null },
  });

const assertion = (over: Record<string, unknown> = {}) => signRs256(key, claims({ email: PERSON, ...over }));
const sessionCookie = (res: Response) => /budget_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? null;

async function cleanup() {
  if (!dbReady) return;
  // PERSON's GET /budgets is the first human session of the run, so it claims
  // the seed's unowned budgets (and the claim finalizes owner NOT NULL): the
  // row cannot be deleted. Leave it as a plain active user instead; the test
  // database is recreated on every run.
  await pool.query(`update public.users set role = 'user', status = 'active' where email = $1`, [PERSON]);
  await pool.query(`delete from public.users where email = $1`, [OTHER]);
}

beforeAll(async () => {
  key = await makeKey('kid-e2e');
  jwks = fakeJwks([key]);
  await cleanup();
});

beforeEach(() => {
  configureAuth(ACCESS_ON());
});

afterAll(async () => {
  await cleanup();
  configureAuth({ authDisabled: true });
});

const dbTest = test.skipIf(!dbReady);

describe('GET /auth/providers', () => {
  test('reports Access on, parses with the contract', async () => {
    const res = await app().request('/auth/providers');
    expect(res.status).toBe(200);
    const body = authProviders.output!.parse(await res.json());
    expect(body.access).toBe(true);
  });

  test('reports Access off when not configured', async () => {
    configureAuth({ ...ACCESS_ON(), accessAud: [] });
    const body = authProviders.output!.parse(await (await app().request('/auth/providers')).json());
    expect(body.access).toBe(false);
  });
});

describe('GET /auth/access (web)', () => {
  dbTest('valid assertion -> budget_session cookie -> GET /budgets 200 with it', async () => {
    const res = await app().request('/auth/access', { headers: { 'Cf-Access-Jwt-Assertion': await assertion() } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(APP);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Domain=.syscd.live');
    const token = sessionCookie(res)!;
    expect(token).toBeTruthy();

    const budgets = await app().request('/budgets', { headers: { cookie: `budget_session=${token}` } });
    expect(budgets.status).toBe(200);
    const me = await app().request('/auth/me', { headers: { cookie: `budget_session=${token}` } });
    expect(await me.json()).toEqual({ email: PERSON });
    // and without it, the data route is closed
    expect((await app().request('/budgets')).status).toBe(401);
  });

  test('no assertion -> 401 access_assertion_missing, no cookie', async () => {
    const res = await app().request('/auth/access');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'no Cloudflare Access assertion on this request', code: 'access_assertion_missing' });
    expect(sessionCookie(res)).toBeNull();
  });

  test('the assertion is read from the header only (not the CF_Authorization cookie, not the query)', async () => {
    const token = await assertion();
    const viaCookie = await app().request('/auth/access', { headers: { cookie: `CF_Authorization=${token}` } });
    expect(viaCookie.status).toBe(401);
    const viaQuery = await app().request(`/auth/access?token=${token}&cf_access_token=${token}`);
    expect(viaQuery.status).toBe(401);
    expect(sessionCookie(viaCookie)).toBeNull();
  });

  test('service-token-shaped assertion -> 401, no session', async () => {
    const svc = await signRs256(key, claims({ email: '', common_name: 'svc.access', sub: '' }));
    const res = await app().request('/auth/access', { headers: { 'Cf-Access-Jwt-Assertion': svc } });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('access_assertion_invalid');
    expect(sessionCookie(res)).toBeNull();
  });

  test('wrong aud / bad token -> 401', async () => {
    for (const t of [await assertion({ aud: ['nope'] }), 'garbage']) {
      const res = await app().request('/auth/access', { headers: { 'Cf-Access-Jwt-Assertion': t } });
      expect(res.status).toBe(401);
    }
  });

  dbTest('return_to: API paths and the web-app origin only', async () => {
    const go = async (rt: string) =>
      (
        await app().request(`/auth/access?return_to=${encodeURIComponent(rt)}`, {
          headers: { 'Cf-Access-Jwt-Assertion': await assertion() },
        })
      ).headers.get('location');
    expect(await go('/oauth/authorize?x=1')).toBe(`${API}/oauth/authorize?x=1`);
    expect(await go(`${APP}/budget/abc?m=2026-11#top`)).toBe(`${APP}/budget/abc?m=2026-11#top`);
    for (const bad of ['https://evil.com/', '//evil.com', '/\\evil.com', 'javascript:alert(1)', `${APP}.evil.com/`, `https://u:p@app.test/`, 'http://app.test/']) {
      expect(await go(bad)).toBe(APP);
    }
  });

  dbTest('with AUTH_ALLOWED_EMAILS set it still applies (403 for others)', async () => {
    configureAuth({ ...ACCESS_ON(), allowedEmails: [OTHER] });
    const res = await app().request('/auth/access', { headers: { 'Cf-Access-Jwt-Assertion': await assertion() } });
    expect(res.status).toBe(403);
    expect(sessionCookie(res)).toBeNull();
  });

  dbTest('links a pre-provisioned (invited) row by e-mail and fills a missing name', async () => {
    await pool.query(`insert into public.users (id, email) values (gen_random_uuid(), $1) on conflict (email) do nothing`, [OTHER]);
    const before = await pool.query<{ id: string }>(`select id from public.users where email = $1`, [OTHER]);
    const res = await app().request('/auth/access', {
      headers: { 'Cf-Access-Jwt-Assertion': await signRs256(key, claims({ email: OTHER.toUpperCase(), name: 'Other Person' })) },
    });
    expect(res.status).toBe(302);
    const after = await pool.query<{ id: string; name: string | null; google_sub: string | null }>(
      `select id, name, google_sub from public.users where email = $1`,
      [OTHER],
    );
    expect(after.rows[0]!.id).toBe(before.rows[0]!.id);
    expect(after.rows[0]!.name).toBe('Other Person');
    expect(after.rows[0]!.google_sub).toBeNull();
  });

  test('Access not configured -> the routes are not there (404)', async () => {
    configureAuth({ ...ACCESS_ON(), accessTeamDomain: '' });
    expect((await app().request('/auth/access', { headers: { 'Cf-Access-Jwt-Assertion': await assertion() } })).status).toBe(404);
    expect((await app().request('/auth/access/native?redirect_uri=budgetapp://login')).status).toBe(404);
    expect((await app().request('/auth/exchange', { method: 'POST', body: '{}' })).status).toBe(404);
  });
});

describe('native: /auth/access/native + POST /auth/exchange', () => {
  const start = async (redirect: string, headers: Record<string, string> = {}) =>
    app().request(`/auth/access/native?redirect_uri=${encodeURIComponent(redirect)}`, { headers });
  const exchange = (code: unknown) =>
    app().request('/auth/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });

  test('refuses a redirect outside the app schemes', async () => {
    for (const bad of ['https://evil.example/cb', 'syscdapp://login', '']) {
      const res = await start(bad, { 'Cf-Access-Jwt-Assertion': await assertion() });
      expect(res.status).toBe(400);
    }
  });

  test('a missing assertion goes back to the app as an error (no code)', async () => {
    const res = await start('budgetapp://login');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('budgetapp://login?error=access_assertion_missing');
  });

  dbTest('hands a one-time code (never the session) to the app; the code buys a Bearer session once', async () => {
    const res = await start('exp://192.168.1.5:8081/--/login', { 'Cf-Access-Jwt-Assertion': await assertion() });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.protocol).toBe('exp:');
    expect(loc.searchParams.get('state')).toBe('access');
    const code = loc.searchParams.get('code')!;
    expect(sessionCookie(res)).toBeNull();

    // the exchange code is not a session
    expect((await app().request('/budgets', { headers: { authorization: `Bearer ${code}` } })).status).toBe(401);

    const ok = await exchange(code);
    expect(ok.status).toBe(200);
    const { token, email } = (await ok.json()) as { token: string; email: string };
    expect(email).toBe(PERSON);
    expect((await app().request('/budgets', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    expect((await exchange(code)).status).toBe(400); // one-time
    expect((await exchange('forged')).status).toBe(400);
    expect((await exchange(await issueSession(SECRET, PERSON, 60))).status).toBe(400); // a session is not a code
  });
});

describe('OAuth consent hand-off', () => {
  dbTest('a logged-out /oauth/authorize goes to /auth/access when Access is configured', async () => {
    const a = app();
    const reg = await a.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Access Test', redirect_uris: ['http://localhost:7777/callback'] }),
    });
    const client = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'http://localhost:7777/callback',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      state: 's',
    });
    const res = await a.request(`/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('/auth/access?return_to=')).toBe(true);
    expect(new URL(loc, API).searchParams.get('return_to')).toBe(`/oauth/authorize?${q}`);
    await pool.query(`delete from public.oauth_clients where client_id = $1`, [client.client_id]);
  });
});

describe('Access-only allow-list semantics and revocation', () => {
  dbTest('no AUTH_ALLOWED_EMAILS: an Access-issued session is not locked out by the per-request check', async () => {
    const token = await issueSession(SECRET, PERSON, 60);
    expect((await app().request('/budgets', { headers: { cookie: `budget_session=${token}` } })).status).toBe(200);
  });

  dbTest('neither an allow-list nor Access: every session is refused (fail closed)', async () => {
    configureAuth({ ...ACCESS_ON(), accessTeamDomain: '', accessAud: [] });
    const token = await issueSession(SECRET, PERSON, 60);
    expect((await app().request('/budgets', { headers: { cookie: `budget_session=${token}` } })).status).toBe(401);
  });

  dbTest("revoking a person: users.status = 'disabled' ends their live session on the next request", async () => {
    const signIn = await app().request('/auth/access', { headers: { 'Cf-Access-Jwt-Assertion': await assertion() } });
    const cookie = `budget_session=${sessionCookie(signIn)}`;
    expect((await app().request('/budgets', { headers: { cookie } })).status).toBe(200);
    await pool.query(`update public.users set status = 'disabled' where email = $1`, [PERSON]);
    try {
      const res = await app().request('/budgets', { headers: { cookie } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'account disabled', code: 'account_disabled' });
    } finally {
      await pool.query(`update public.users set status = 'active' where email = $1`, [PERSON]);
    }
  });
});
