/**
 * Sign in with Cloudflare Access, end to end through the composed app
 * (buildApp, real auth gate, real DB): a FAKE JWKS (local key pair, injected
 * fetch) stands in for Cloudflare. Covers /auth/access (web cookie),
 * /auth/access/native + /auth/exchange (native token), /auth/providers,
 * the OAuth consent hand-off, the allow-list rule (Access sign-ins are not
 * held to AUTH_ALLOWED_EMAILS; Google ones are), a brand-new person's first
 * sign-in (a user, zero budgets, nothing created), an invited person's first
 * sign-in (same user, the shared budget is there) and the revocation path
 * (users.status).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createHash, randomBytes } from 'node:crypto';

import { budgetCreate, budgetList, membersAdd, membersLinkEmail, membersList } from '@shared/contracts/budget';
import { connectionsList, connectionsSettingsGet } from '@shared/contracts/connections/connections';
import { meGet } from '@shared/contracts/user';
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
/** An operator row that exists before anyone in this file signs in (so nobody here is "the first user"). */
const OPERATOR = 'access-operator@accesssignin.test';
/** People the app has never seen. */
const NEWCOMER = 'access-newcomer@accesssignin.test';
const INVITED = 'access-invited@accesssignin.test';
const LINKED = 'access-linked@accesssignin.test';
const SHARER = 'access-sharer@accesssignin.test';
const FRESH = [NEWCOMER, INVITED, LINKED, SHARER];

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
  // PERSON is left in place as a plain active user (the test database is
  // recreated on every run); everyone else this file creates is removed.
  await pool.query(`update public.users set role = 'user', status = 'active' where email = $1`, [PERSON]);
  await pool.query(`delete from public.users where email = $1`, [OTHER]);
  await pool.query(`delete from public.budgets where owner_user_id in (select id from public.users where email = any($1))`, [FRESH]);
  await pool.query(`delete from public.users where email = any($1)`, [[...FRESH, OPERATOR]]);
}

beforeAll(async () => {
  key = await makeKey('kid-e2e');
  jwks = fakeJwks([key]);
  await cleanup();
  if (dbReady) await pool.query(`insert into public.users (id, email, role) values (gen_random_uuid(), $1, 'admin')`, [OPERATOR]);
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

describe('first sign-in through Access (no sign-up, no API-side allow-listing)', () => {
  /** Sign in through Access as `email`; returns the session cookie header. */
  const signIn = async (email: string, name?: string) => {
    const res = await app().request('/auth/access', {
      headers: { 'Cf-Access-Jwt-Assertion': await signRs256(key, claims({ email, ...(name ? { name } : {}) })) },
    });
    expect(res.status).toBe(302);
    return { cookie: `budget_session=${sessionCookie(res)}` };
  };
  const call = (headers: Record<string, string>, path: string, init: { method?: string; body?: unknown } = {}) =>
    app().request(path, {
      method: init.method ?? 'GET',
      headers: { ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  const userRow = async (email: string) =>
    (await pool.query<{ id: string; role: string; google_sub: string | null; signed_in_at: Date | null }>(
      `select id, role, google_sub, signed_in_at from public.users where email = $1`, [email])).rows[0];
  const budgetCount = async () => (await pool.query<{ n: number }>('select count(*)::int as n from public.budgets')).rows[0]!.n;

  // AUTH_ALLOWED_EMAILS belongs to Google: it names somebody else in every case here.
  beforeEach(() => configureAuth({ ...ACCESS_ON(), allowedEmails: [OTHER] }));

  dbTest('someone the app has never seen gets a user and lands signed in with zero budgets; nothing is created for them', async () => {
    expect(await userRow(NEWCOMER)).toBeUndefined();
    const budgetsBefore = await budgetCount();
    const unownedBefore = (await pool.query(`select count(*)::int as n from public.budgets where owner_user_id is null`)).rows[0].n;

    const who = await signIn(NEWCOMER, 'New Comer');
    const row = await userRow(NEWCOMER);
    expect(row).toMatchObject({ role: 'user', google_sub: null });
    expect(row!.signed_in_at).not.toBeNull();

    // Everything the client calls at boot answers, with nothing in it.
    expect(await (await call(who, '/auth/me')).json()).toEqual({ email: NEWCOMER });
    const me = await call(who, '/me');
    expect(me.status).toBe(200);
    expect(meGet.output!.parse(await me.json())).toMatchObject({ id: row!.id, email: NEWCOMER, name: 'New Comer', role: 'user' });
    const budgets = await call(who, '/budgets');
    expect(budgets.status).toBe(200);
    expect(budgetList.output!.parse(await budgets.json())).toEqual([]);
    const conns = await call(who, '/connections');
    expect(conns.status).toBe(200);
    expect(connectionsList.output!.parse(await conns.json())).toEqual([]);
    const settings = await call(who, '/connections/settings');
    expect(settings.status).toBe(200);
    connectionsSettingsGet.output!.parse(await settings.json());
    expect((await call(who, '/oauth/grants')).status).toBe(200);

    // No budget was created or handed to them (unowned legacy budgets stay unowned).
    expect(await budgetCount()).toBe(budgetsBefore);
    expect((await pool.query(`select count(*)::int as n from public.budgets where owner_user_id is null`)).rows[0].n).toBe(unownedBefore);
    expect((await pool.query(`select 1 from public.budget_members where user_id = $1`, [row!.id])).rowCount).toBe(0);

    // They can create their own, and then it is theirs alone.
    const created = await call(who, '/budgets', { method: 'POST', body: { name: 'Newcomer budget' } });
    expect(created.status).toBe(200);
    const mine = budgetCreate.output!.parse(await created.json());
    const list = budgetList.output!.parse(await (await call(who, '/budgets')).json());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: mine.id, is_owner: true, member_count: 1, owner: { user_id: row!.id, email: NEWCOMER, name: 'New Comer' } });
  });

  dbTest('the Google list still guards Google: the same person cannot hold an unmarked (Google-style) session', async () => {
    await signIn(NEWCOMER);
    const googleStyle = await issueSession(SECRET, NEWCOMER, 60);
    expect((await call({ cookie: `budget_session=${googleStyle}` }, '/budgets')).status).toBe(401);
    expect((await call({ authorization: `Bearer ${googleStyle}` }, '/budgets')).status).toBe(401);
    // ...and an Access-marked session stops working if Access is switched off.
    const marked = await issueSession(SECRET, NEWCOMER, 60, 'access');
    expect((await call({ cookie: `budget_session=${marked}` }, '/budgets')).status).toBe(200);
    configureAuth({ ...ACCESS_ON(), accessTeamDomain: '', accessAud: [], allowedEmails: [OTHER], googleClientId: 'cid', googleClientSecret: 'sec' });
    expect((await call({ cookie: `budget_session=${marked}` }, '/budgets')).status).toBe(401);
  });

  dbTest('native: the exchange code buys an Access-marked session for a person who is not on the Google list', async () => {
    const start = await app().request(`/auth/access/native?redirect_uri=${encodeURIComponent('budgetapp://login')}`, {
      headers: { 'Cf-Access-Jwt-Assertion': await signRs256(key, claims({ email: NEWCOMER })) },
    });
    const code = new URL(start.headers.get('location')!).searchParams.get('code')!;
    const ex = await call({}, '/auth/exchange', { method: 'POST', body: { code } });
    expect(ex.status).toBe(200);
    const { token } = (await ex.json()) as { token: string };
    expect((await call({ authorization: `Bearer ${token}` }, '/budgets')).status).toBe(200);
  });

  dbTest('an invited e-mail signs in for the first time as that same user and sees the shared budget', async () => {
    const sharer = await signIn(SHARER, 'Sha Rer');
    const budget = budgetCreate.output!.parse(await (await call(sharer, '/budgets', { method: 'POST', body: { name: 'Shared trip' } })).json());
    const added = await call(sharer, '/budget-members', { method: 'POST', body: { budget_id: budget.id, email: INVITED } });
    expect(added.status).toBe(200);
    const invitedMember = membersAdd.output!.parse(await added.json()).members.find((m) => m.email === INVITED)!;
    expect(invitedMember.pending).toBe(true);
    expect((await userRow(INVITED))!.signed_in_at).toBeNull();

    const invited = await signIn(INVITED, 'In Vited');
    expect((await userRow(INVITED))!.id).toBe(invitedMember.user_id); // same user, not a second row
    expect((await pool.query(`select count(*)::int as n from public.users where email = $1`, [INVITED])).rows[0].n).toBe(1);

    const list = budgetList.output!.parse(await (await call(invited, '/budgets')).json());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: budget.id,
      name: 'Shared trip',
      is_owner: false,
      member_count: 2,
      owner: { user_id: (await userRow(SHARER))!.id, email: SHARER, name: 'Sha Rer' },
    });
    expect((await call(invited, `/accounts?budget_id=${budget.id}`)).status).toBe(200);

    // No longer pending, and a signed-in person's name is their own (Access users have no google_sub).
    const members = membersList.output!.parse(await (await call(sharer, `/budget-members?budget_id=${budget.id}`)).json());
    expect(members.members.find((m) => m.email === INVITED)).toMatchObject({ pending: false, name: 'In Vited' });
    const rename = await call(sharer, '/budget-members', { method: 'PATCH', body: { budget_id: budget.id, user_id: invitedMember.user_id, name: 'Renamed By Owner' } });
    expect(rename.status).toBe(400);
    // The sharer's own list says it is theirs, shared with one more person.
    const own = budgetList.output!.parse(await (await call(sharer, '/budgets')).json());
    expect(own.find((b) => b.id === budget.id)).toMatchObject({ is_owner: true, member_count: 2 });
  });

  dbTest('a placeholder person linked to an e-mail signs in as that person', async () => {
    const sharer = await signIn(SHARER);
    const budget = budgetCreate.output!.parse(await (await call(sharer, '/budgets', { method: 'POST', body: { name: 'Placeholder budget' } })).json());
    const ph = membersAdd.output!.parse(
      await (await call(sharer, '/budget-members', { method: 'POST', body: { budget_id: budget.id, name: 'Lin Ked' } })).json(),
    ).members.find((m) => m.name === 'Lin Ked')!;
    expect(ph.email).toBeNull();
    const linked = await call(sharer, '/budget-members/link-email', { method: 'POST', body: { budget_id: budget.id, user_id: ph.user_id, email: LINKED } });
    expect(linked.status).toBe(200);
    membersLinkEmail.output!.parse(await linked.json());

    const who = await signIn(LINKED);
    expect((await userRow(LINKED))!.id).toBe(ph.user_id);
    const list = budgetList.output!.parse(await (await call(who, '/budgets')).json());
    expect(list.map((b) => [b.id, b.is_owner])).toEqual([[budget.id, false]]);
    expect(meGet.output!.parse(await (await call(who, '/me')).json()).name).toBe('Lin Ked');
  });

  dbTest('OAuth (MCP/CLI): a grant approved from an Access session works for a person who is not on the Google list', async () => {
    const a = app();
    const who = await signIn(NEWCOMER);
    const reg = await a.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Access Grant Test', redirect_uris: ['http://localhost:7777/callback'] }),
    });
    const client = (await reg.json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'http://localhost:7777/callback',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 's',
    });
    const page = await a.request(`/oauth/authorize?${q}`, { headers: who });
    expect(page.status).toBe(200);
    const fields: Record<string, string> = {};
    for (const m of (await page.text()).matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) {
      fields[m[1]!] = m[2]!.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
    }
    const approve = await a.request('/oauth/authorize', {
      method: 'POST',
      headers: { ...who, origin: API, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, decision: 'approve' }),
    });
    expect(approve.status).toBe(303);
    const code = new URL(approve.headers.get('location')!).searchParams.get('code')!;
    const tok = await a.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: 'http://localhost:7777/callback', code_verifier: verifier }),
    });
    expect(tok.status).toBe(200);
    const { access_token: token } = (await tok.json()) as { access_token: string };
    try {
      expect((await pool.query(`select idp from public.oauth_grants where client_id = $1`, [client.client_id])).rows[0].idp).toBe('access');
      const res = await a.request('/budgets', { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      // Take the marker off the grant: the token is then judged against the Google list, which does not name them.
      await pool.query(`update public.oauth_grants set idp = null where client_id = $1`, [client.client_id]);
      expect((await a.request('/budgets', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    } finally {
      await pool.query(`delete from public.oauth_clients where client_id = $1`, [client.client_id]);
    }
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
