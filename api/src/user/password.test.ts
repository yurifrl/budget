/**
 * Password sign-in, Google linking and /admin/users, end to end through the
 * composed app (buildApp, real auth gate, real DB). Google is replaced by a
 * module mock whose identity each test sets.
 *
 * argon2id runs at a LOW cost here (`passwordHashCost`, never read from env):
 * production keeps Bun's defaults; verification always uses the parameters
 * stored in each hash.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createHmac } from 'node:crypto';

import { adminUserSchema } from '@shared/contracts/user/admin-users';
import { buildApp } from '../app';
import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { defaultOAuthTtls } from '../oauth';
import { issueAccessToken, issueSession, verifySession } from './auth';
import { authConfig, configureAuth, type AuthConfig } from './config';
import { CHANGE_TOKEN_TTL_SECONDS, generateTempPassword, hashPassword, TEMP_PASSWORD_ALPHABET } from './password';
import { IP_MAX_FAILURES, resetIpLimiter } from './throttle';

const SECRET = 'p'.repeat(40);
const API = 'https://api.test';
const APP = 'https://app.test';
const ADMIN_ORIGIN = 'https://admin.test';
const SVC_TOKEN = 'svc-token-for-password-tests-0123456789';
const D = '@pwtest.test';
const LISTED = `listed${D}`;
const GOOD = 'correct horse battery staple';
const NEW_GOOD = 'another fine long passphrase';

// ---- Google mock: identity per test ------------------------------------------
let googleIdentity: { email: string; sub: string; emailVerified: boolean; name?: string } | null = null;
mock.module('./google', () => ({
  googleConfigured: () => !!(authConfig().googleClientId && authConfig().googleClientSecret),
  googleAuthUrl: (redirect: string, state: string) => `https://g.test?redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}`,
  exchangeCode: async () => googleIdentity,
}));

const CONFIG = (): Partial<AuthConfig> => ({
  sessionSecret: SECRET,
  apiBaseUrl: API,
  appOrigin: APP,
  allowedEmails: [LISTED],
  googleClientId: 'cid',
  googleClientSecret: 'csec',
  serviceToken: SVC_TOKEN,
  passwordLogin: true,
  passwordHashCost: { memoryCost: 1024, timeCost: 1 },
});

const app = () =>
  buildApp({
    appOrigin: APP,
    adminOrigins: [ADMIN_ORIGIN],
    version: 't',
    oauth: { ...defaultOAuthTtls, issuer: API, resource: `${API}/mcp`, secret: SECRET, devEmail: null },
  });

// ---- helpers ----------------------------------------------------------------
type Opts = { role?: 'admin' | 'user'; status?: 'active' | 'disabled'; password?: string; mustChange?: boolean; tempExpired?: boolean; googleSub?: string };

async function makeUser(local: string, o: Opts = {}): Promise<{ id: string; email: string }> {
  const email = `${local}${D}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.users (id, email, role, status, google_sub, signed_in_at) values (gen_random_uuid(), $1, $2, $3, $4, now()) returning id`,
    [email, o.role ?? 'user', o.status ?? 'active', o.googleSub ?? null],
  );
  const id = rows[0]!.id;
  if (o.password !== undefined) {
    await pool.query(
      `insert into public.user_passwords (user_id, password_hash, must_change, temp_expires_at) values ($1, $2, $3, $4)`,
      [id, await hashPassword(o.password), !!o.mustChange, o.mustChange ? new Date(Date.now() + (o.tempExpired ? -1000 : 86_400_000)) : null],
    );
  }
  return { id, email };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') {
  const res = await app().request(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { res, status: res.status, json: text ? JSON.parse(text) : null };
}
const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await app().request(`${API}${path}`, { headers });
  const text = await res.text();
  return { res, status: res.status, json: text ? JSON.parse(text) : null };
};
const cookieOf = (res: Response) => /budget_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? null;
const withCookie = (t: string) => ({ cookie: `budget_session=${t}` });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const login = (email: string, password: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post('/auth/password/login', { email, password, ...extra }, headers);

async function cookieLogin(email: string, password = GOOD): Promise<string> {
  const r = await login(email, password);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return cookieOf(r.res)!;
}

async function cleanup() {
  if (!dbReady) return;
  await pool.query(`delete from public.budgets where owner_user_id in (select id from public.users where email like $1)`, [`%${D}`]);
  await pool.query(`delete from public.oauth_grants where user_id in (select id from public.users where email like $1)`, [`%${D}`]);
  await pool.query(`delete from public.users where email like $1`, [`%${D}`]);
  await pool.query(`delete from public.auth_login_throttle where email like $1`, [`%${D}`]);
}

beforeAll(cleanup);
beforeEach(async () => {
  configureAuth(CONFIG());
  resetIpLimiter();
  googleIdentity = null;
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  configureAuth({ authDisabled: true });
});

const dbTest = test.skipIf(!dbReady);

// ---- unit: tokens and temp passwords --------------------------------------------
describe('session claims and temporary passwords', () => {
  test('a password session round-trips its marker and version; without a version it is refused', async () => {
    const t = await issueSession(SECRET, 'a@b.c', 60, 'password', 3);
    expect(await verifySession(SECRET, t)).toEqual({ email: 'a@b.c', idp: 'password', pwv: 3 });
    await expect(issueSession(SECRET, 'a@b.c', 60, 'password')).rejects.toThrow();
    const { sign } = await import('hono/jwt');
    const now = Math.floor(Date.now() / 1000);
    const forged = await sign({ sub: 'a@b.c', kind: 'session', idp: 'password', iat: now, exp: now + 60 }, SECRET, 'HS256');
    expect(await verifySession(SECRET, forged)).toBeNull();
    // Access and unmarked sessions are unchanged.
    expect(await verifySession(SECRET, await issueSession(SECRET, 'a@b.c', 60, 'access'))).toEqual({ email: 'a@b.c', idp: 'access' });
    expect(await verifySession(SECRET, await issueSession(SECRET, 'a@b.c', 60))).toEqual({ email: 'a@b.c' });
  });

  test('temporary passwords: 4 groups of 5 from the readable alphabet (~99 bits), all different', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateTempPassword();
      expect(p).toMatch(new RegExp(`^[${TEMP_PASSWORD_ALPHABET}]{5}(-[${TEMP_PASSWORD_ALPHABET}]{5}){3}$`));
      seen.add(p);
    }
    expect(seen.size).toBe(200);
    expect(20 * Math.log2(TEMP_PASSWORD_ALPHABET.length)).toBeGreaterThanOrEqual(80);
  });
});

// ---- login --------------------------------------------------------------------
describe('POST /auth/password/login', () => {
  dbTest('web: session cookie, no token in the body; the cookie passes the gate', async () => {
    await makeUser('web', { password: GOOD });
    const r = await login(`Web${D}`.toUpperCase(), GOOD);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: 'signed_in', email: `web${D}` });
    const set = r.res.headers.get('set-cookie')!;
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    const me = await get('/me', withCookie(cookieOf(r.res)!));
    expect(me.status).toBe(200);
    expect(me.json.has_password).toBe(true);
    expect((await get('/auth/me', withCookie(cookieOf(r.res)!))).json).toEqual({ email: `web${D}` });
  });

  dbTest('native: token in the body, no cookie; the token works as Bearer', async () => {
    await makeUser('native', { password: GOOD });
    const r = await login(`native${D}`, GOOD, { session: 'token' });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('signed_in');
    expect(typeof r.json.token).toBe('string');
    expect(r.res.headers.get('set-cookie')).toBeNull();
    expect((await get('/me', bearer(r.json.token))).status).toBe(200);
  });

  dbTest('unknown e-mail, wrong password, no password row and disabled user: the same 401, one argon2 verification each', async () => {
    await makeUser('wrong', { password: GOOD });
    await makeUser('nopw', { googleSub: 'g-nopw' });
    await makeUser('disabled', { password: GOOD, status: 'disabled' });
    const verify = spyOn(Bun.password, 'verify');
    const results = [];
    for (const [email, pw] of [
      [`ghost${D}`, GOOD],
      [`wrong${D}`, 'not the password at all'],
      [`nopw${D}`, GOOD],
      [`disabled${D}`, GOOD],
    ] as const) {
      verify.mockClear();
      const r = await login(email, pw);
      results.push({ status: r.status, body: r.json, cookie: r.res.headers.get('set-cookie') });
      expect(verify.mock.calls.length, email).toBe(1);
    }
    verify.mockRestore();
    for (const r of results) {
      expect(r).toEqual({ status: 401, body: { error: 'invalid e-mail or password', code: 'invalid_credentials' }, cookie: null });
    }
  });

  dbTest('refuses a foreign Origin and a non-JSON body; allows the app and admin origins and no Origin', async () => {
    await makeUser('origin', { password: GOOD });
    expect((await login(`origin${D}`, GOOD, {}, { origin: 'https://evil.syscd.live' })).json.code).toBe('origin_not_allowed');
    expect((await login(`origin${D}`, GOOD, {}, { origin: APP })).status).toBe(200);
    expect((await login(`origin${D}`, GOOD, {}, { origin: ADMIN_ORIGIN })).status).toBe(200);
    const res = await app().request(`${API}/auth/password/login`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ email: `origin${D}`, password: GOOD }),
    });
    expect(res.status).toBe(415);
  });
});

// ---- throttling ----------------------------------------------------------------
describe('throttling', () => {
  dbTest('5 failures lock the e-mail: 429 + Retry-After BEFORE verification, even with the right password', async () => {
    await makeUser('lock', { password: GOOD });
    for (let i = 0; i < 5; i++) expect((await login(`lock${D}`, 'bad password 123')).status).toBe(401);
    const verify = spyOn(Bun.password, 'verify');
    const r = await login(`lock${D}`, GOOD);
    expect(verify.mock.calls.length).toBe(0);
    verify.mockRestore();
    expect(r.status).toBe(429);
    expect(r.json.code).toBe('too_many_attempts');
    const retry = Number(r.res.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
  });

  dbTest('unknown e-mails lock the same way (no enumeration through the lockout)', async () => {
    for (let i = 0; i < 5; i++) expect((await login(`nobody${D}`, 'bad password 123')).status).toBe(401);
    const r = await login(`nobody${D}`, 'bad password 123');
    expect(r.status).toBe(429);
    expect(r.json.code).toBe('too_many_attempts');
  });

  dbTest('a success clears the count', async () => {
    await makeUser('clear', { password: GOOD });
    for (let i = 0; i < 4; i++) await login(`clear${D}`, 'bad password 123');
    expect((await login(`clear${D}`, GOOD)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(`clear${D}`, 'bad password 123')).status).toBe(401);
    expect((await login(`clear${D}`, GOOD)).status).toBe(200);
  });

  dbTest('an admin reset clears the lock', async () => {
    await makeUser('admin-r', { role: 'admin', password: GOOD });
    const target = await makeUser('locked-r', { password: GOOD });
    for (let i = 0; i < 5; i++) await login(`locked-r${D}`, 'bad password 123');
    expect((await login(`locked-r${D}`, GOOD)).status).toBe(429);
    const adminCookie = await cookieLogin(`admin-r${D}`);
    const list = await get('/admin/users', withCookie(adminCookie));
    expect(list.json.find((u: { email: string }) => u.email === `locked-r${D}`).locked_until).not.toBeNull();
    const reset = await post(`/admin/users/${target.id}/reset-password`, undefined, withCookie(adminCookie));
    expect(reset.status).toBe(200);
    expect(reset.json.user.locked_until).toBeNull();
    const r = await login(`locked-r${D}`, reset.json.temp_password);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('password_change_required');
  });

  dbTest('per client address: too many failures from one address are refused, another address is not', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.7' };
    for (let i = 0; i < IP_MAX_FAILURES; i++) expect((await login(`spray${i}${D}`, 'bad password 123', {}, ip)).status).toBe(401);
    const r = await login(`spray-last${D}`, 'bad password 123', {}, ip);
    expect(r.status).toBe(429);
    expect(r.json.code).toBe('too_many_attempts');
    expect((await login(`spray-last${D}`, 'bad password 123', {}, { 'cf-connecting-ip': '203.0.113.8' })).status).toBe(401);
  });
});

// ---- temporary passwords --------------------------------------------------------
describe('temporary password and change token', () => {
  dbTest('a temporary password gives a change token, not a session; complete sets the password and signs in', async () => {
    await makeUser('temp', { password: 'temp-abcde-fghij', mustChange: true });
    const r = await login(`temp${D}`, 'temp-abcde-fghij');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'password_change_required', email: `temp${D}`, expires_in: CHANGE_TOKEN_TTL_SECONDS });
    expect(r.res.headers.get('set-cookie')).toBeNull();
    const changeToken = r.json.change_token as string;

    // Single-purpose: not a session (cookie or Bearer), not an OAuth token.
    expect((await get('/me', bearer(changeToken))).status).toBe(401);
    expect((await get('/me', withCookie(changeToken))).status).toBe(401);
    expect((await get('/auth/me', bearer(changeToken))).status).toBe(401);
    expect((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, bearer(changeToken))).status).toBe(401); // not a session, not an access token
    expect((await post('/auth/exchange', { code: changeToken })).status).toBe(404); // Access off

    // Policy, then "not the temporary password".
    expect((await post('/auth/password/complete', { change_token: changeToken, new_password: 'short' })).json.code).toBe('password_too_short');
    expect((await post('/auth/password/complete', { change_token: changeToken, new_password: `temp${D}` })).json.code).toBe('password_is_email');
    expect((await post('/auth/password/complete', { change_token: changeToken, new_password: 'password1234' })).json.code).toBe('password_too_common');
    expect((await post('/auth/password/complete', { change_token: changeToken, new_password: 'temp-abcde-fghij' })).json.code).toBe('password_unchanged');

    const done = await post('/auth/password/complete', { change_token: changeToken, new_password: GOOD });
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ status: 'signed_in', email: `temp${D}` });
    expect((await get('/me', withCookie(cookieOf(done.res)!))).status).toBe(200);

    // Spent.
    const replay = await post('/auth/password/complete', { change_token: changeToken, new_password: NEW_GOOD });
    expect(replay.status).toBe(401);
    expect(replay.json.code).toBe('invalid_change_token');
    expect((await login(`temp${D}`, 'temp-abcde-fghij')).status).toBe(401);
    expect((await login(`temp${D}`, GOOD)).json.status).toBe('signed_in');
  });

  dbTest('complete with session=token returns a token and no cookie', async () => {
    await makeUser('temp-n', { password: 'temp-native-pass', mustChange: true });
    const r = await login(`temp-n${D}`, 'temp-native-pass');
    const done = await post('/auth/password/complete', { change_token: r.json.change_token, new_password: GOOD, session: 'token' });
    expect(done.status).toBe(200);
    expect(typeof done.json.token).toBe('string');
    expect(done.res.headers.get('set-cookie')).toBeNull();
    expect((await get('/me', bearer(done.json.token))).status).toBe(200);
  });

  dbTest('a forged or foreign token is refused', async () => {
    const session = await issueSession(SECRET, `x${D}`, 60);
    expect((await post('/auth/password/complete', { change_token: session, new_password: GOOD })).json.code).toBe('invalid_change_token');
    expect((await post('/auth/password/complete', { change_token: 'nope', new_password: GOOD })).json.code).toBe('invalid_change_token');
  });

  dbTest('an expired temporary password says so only when it was right', async () => {
    await makeUser('expired', { password: 'temp-expired-pass', mustChange: true, tempExpired: true });
    const right = await login(`expired${D}`, 'temp-expired-pass');
    expect(right.status).toBe(401);
    expect(right.json.code).toBe('temp_password_expired');
    expect((await login(`expired${D}`, 'something else entirely')).json.code).toBe('invalid_credentials');
  });
});

// ---- change password ----------------------------------------------------------------
describe('POST /auth/password/change', () => {
  dbTest('re-verifies, ends the other password sessions and re-issues the caller', async () => {
    await makeUser('chg', { password: GOOD });
    const a = await cookieLogin(`chg${D}`);
    const b = await login(`chg${D}`, GOOD, { session: 'token' });
    const wrong = await post('/auth/password/change', { current_password: 'not it at all', new_password: NEW_GOOD }, withCookie(a));
    expect(wrong.status).toBe(401);
    expect(wrong.json.code).toBe('invalid_credentials');
    expect((await post('/auth/password/change', { current_password: GOOD, new_password: GOOD }, withCookie(a))).json.code).toBe('password_unchanged');

    const ok = await post('/auth/password/change', { current_password: GOOD, new_password: NEW_GOOD }, withCookie(a));
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true });
    const fresh = cookieOf(ok.res)!;
    expect(fresh).toBeTruthy();
    expect((await get('/me', withCookie(fresh))).status).toBe(200);
    expect((await get('/me', withCookie(a))).status).toBe(401);
    expect((await get('/me', bearer(b.json.token))).status).toBe(401);
    expect((await login(`chg${D}`, GOOD)).status).toBe(401);
    expect((await login(`chg${D}`, NEW_GOOD)).status).toBe(200);
  });

  dbTest('a Bearer caller gets its new token in the body', async () => {
    await makeUser('chg-b', { password: GOOD });
    const t = (await login(`chg-b${D}`, GOOD, { session: 'token' })).json.token;
    const ok = await post('/auth/password/change', { current_password: GOOD, new_password: NEW_GOOD }, bearer(t));
    expect(ok.status).toBe(200);
    expect(typeof ok.json.token).toBe('string');
    expect((await get('/me', bearer(ok.json.token))).status).toBe(200);
    expect((await get('/me', bearer(t))).status).toBe(401);
  });

  dbTest('failures count toward the same lock', async () => {
    await makeUser('chg-l', { password: GOOD });
    const a = await cookieLogin(`chg-l${D}`);
    for (let i = 0; i < 5; i++) await post('/auth/password/change', { current_password: 'not it at all', new_password: NEW_GOOD }, withCookie(a));
    expect((await post('/auth/password/change', { current_password: GOOD, new_password: NEW_GOOD }, withCookie(a))).status).toBe(429);
  });

  dbTest('OAuth access tokens and the service token are refused; no password = 400', async () => {
    const u = await makeUser('chg-o', { password: GOOD });
    const tok = await grantToken(u.id, u.email, null);
    expect((await post('/auth/password/change', { current_password: GOOD, new_password: NEW_GOOD }, bearer(tok))).status).toBe(403);
    expect((await post('/auth/password/change', { current_password: GOOD, new_password: NEW_GOOD }, bearer(SVC_TOKEN))).status).toBe(403);
    await makeUser('listed', { googleSub: 'g-listed' });
    const google = await issueSession(SECRET, LISTED, 60);
    expect((await post('/auth/password/change', { current_password: GOOD, new_password: NEW_GOOD }, withCookie(google))).json.code).toBe('no_password');
  });
});

async function grantToken(userId: string, email: string, idp: string | null): Promise<string> {
  const clientId = `c_pwtest_${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(`insert into public.oauth_clients (client_id, client_name, redirect_uris) values ($1, 'pw test', $2)`, [clientId, ['https://cb.test']]);
  const grantId = crypto.randomUUID();
  await pool.query(
    `insert into public.oauth_grants (id, user_id, client_id, scope, resource, expires_at, idp) values ($1, $2, $3, 'read write', $4, now() + interval '1 hour', $5)`,
    [grantId, userId, clientId, `${API}/mcp`, idp],
  );
  return issueAccessToken(SECRET, { email, scope: 'read write', clientId, grantId, audience: `${API}/mcp` }, 600);
}

// ---- the per-request rule ---------------------------------------------------------
describe('password sessions per request', () => {
  dbTest('never create a user row', async () => {
    const t = await issueSession(SECRET, `phantom${D}`, 60, 'password', 1);
    expect((await get('/me', withCookie(t))).status).toBe(401);
    expect((await get('/auth/me', bearer(t))).status).toBe(401);
    expect((await pool.query('select 1 from public.users where email = $1', [`phantom${D}`])).rowCount).toBe(0);
  });

  dbTest('die when the user is disabled, deleted, loses the password row, or password login is turned off', async () => {
    const u = await makeUser('die', { password: GOOD });
    const fresh = async () => cookieLogin(`die${D}`);

    let c = await fresh();
    await pool.query(`update public.users set status = 'disabled' where id = $1`, [u.id]);
    expect((await get('/me', withCookie(c))).status).toBe(401);
    expect((await get('/auth/me', withCookie(c))).status).toBe(401);
    await pool.query(`update public.users set status = 'active' where id = $1`, [u.id]);

    c = await fresh();
    configureAuth({ ...CONFIG(), passwordLogin: false });
    expect((await get('/me', withCookie(c))).status).toBe(401);
    expect((await login(`die${D}`, GOOD)).status).toBe(404);
    expect((await post('/auth/password/complete', { change_token: 'x', new_password: GOOD })).status).toBe(404);
    expect((await post('/auth/password/change', { current_password: GOOD, new_password: NEW_GOOD }, withCookie(c))).status).toBe(401);
    expect((await get('/auth/providers')).json).toEqual({ access: false, google: true, password: false });
    configureAuth(CONFIG());
    expect((await get('/auth/providers')).json.password).toBe(true);
    expect((await get('/me', withCookie(c))).status).toBe(200);

    await pool.query('delete from public.user_passwords where user_id = $1', [u.id]);
    expect((await get('/me', withCookie(c))).status).toBe(401);
    await pool.query(`insert into public.user_passwords (user_id, password_hash) values ($1, $2)`, [u.id, await hashPassword(GOOD)]);

    c = await fresh();
    await pool.query('delete from public.users where id = $1', [u.id]);
    expect((await get('/me', withCookie(c))).status).toBe(401);
    expect((await pool.query('select 1 from public.users where email = $1', [`die${D}`])).rowCount).toBe(0);
  });

  dbTest('an OAuth grant approved from a password session follows the same rule and is revoked by a password change', async () => {
    const u = await makeUser('grant', { password: GOOD });
    const tok = await grantToken(u.id, u.email, 'password');
    expect((await get('/auth/me', bearer(tok))).status).toBe(200);
    configureAuth({ ...CONFIG(), passwordLogin: false });
    expect((await get('/auth/me', bearer(tok))).status).toBe(401);
    configureAuth(CONFIG());
    const c = await cookieLogin(`grant${D}`);
    expect((await post('/auth/password/change', { current_password: GOOD, new_password: NEW_GOOD }, withCookie(c))).status).toBe(200);
    expect((await get('/auth/me', bearer(tok))).status).toBe(401);
  });
});

// ---- Google linking --------------------------------------------------------------
describe('Google sign-in of an admin-managed e-mail', () => {
  const ticket = (nonce: string) => `${nonce}.${createHmac('sha256', SECRET).update(nonce).digest('base64url')}`;
  const webCallback = () => app().request(`${API}/auth/google/callback?code=c&state=s1`, { headers: { cookie: 'g_state=s1' } });
  const nativeToken = () => app().request(`${API}/auth/token?code=c&state=${encodeURIComponent(ticket('n1'))}`);

  dbTest('web: not on the Google list, lands on the same row and passes the gate', async () => {
    const u = await makeUser('managed', { password: GOOD });
    googleIdentity = { email: `managed${D}`, sub: 'g-managed', emailVerified: true };
    const res = await webCallback();
    expect(res.status).toBe(302);
    const token = cookieOf(res)!;
    const me = await get('/me', withCookie(token));
    expect(me.status).toBe(200);
    expect(me.json.id).toBe(u.id);
    expect((await pool.query('select google_sub from public.users where id = $1', [u.id])).rows[0].google_sub).toBe('g-managed');
    expect((await pool.query('select count(*)::int as n from public.users where email = $1', [`managed${D}`])).rows[0].n).toBe(1);

    // The exception is "admin-managed": losing the password row ends it.
    await pool.query('delete from public.user_passwords where user_id = $1', [u.id]);
    expect((await get('/me', withCookie(token))).status).toBe(401);
  });

  dbTest('native: /auth/token gives a token for the same row', async () => {
    const u = await makeUser('managed-n', { password: GOOD });
    googleIdentity = { email: `managed-n${D}`, sub: 'g-managed-n', emailVerified: true };
    const res = await nativeToken();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const me = await get('/me', bearer(body.token));
    expect(me.json.id).toBe(u.id);
  });

  dbTest('a non-managed e-mail off the list is still refused (web and native); a disabled managed one too', async () => {
    await makeUser('plain', { googleSub: 'g-plain' });
    googleIdentity = { email: `plain${D}`, sub: 'g-plain', emailVerified: true };
    expect((await webCallback()).status).toBe(403);
    expect((await nativeToken()).status).toBe(403);
    googleIdentity = { email: `stranger${D}`, sub: 'g-stranger', emailVerified: true };
    expect((await webCallback()).status).toBe(403);
    expect((await pool.query('select 1 from public.users where email = $1', [`stranger${D}`])).rowCount).toBe(0);
    await makeUser('managed-d', { password: GOOD, status: 'disabled' });
    googleIdentity = { email: `managed-d${D}`, sub: 'g-managed-d', emailVerified: true };
    expect((await webCallback()).status).toBe(403);
    // email_verified stays mandatory; a different google_sub on the row is still refused.
    await makeUser('managed-u', { password: GOOD });
    googleIdentity = { email: `managed-u${D}`, sub: 'g-u', emailVerified: false };
    expect((await webCallback()).status).toBe(401);
    await makeUser('managed-s', { password: GOOD, googleSub: 'g-original' });
    googleIdentity = { email: `managed-s${D}`, sub: 'g-other', emailVerified: true };
    expect((await webCallback()).status).toBe(403);
    // An unmarked session of a non-managed e-mail off the list fails the gate.
    expect((await get('/me', withCookie(await issueSession(SECRET, `plain${D}`, 60)))).status).toBe(401);
  });

  dbTest('reverse: a Google user given a password by an admin signs in with it into the same row', async () => {
    await makeUser('boss', { role: 'admin', password: GOOD });
    const g = await makeUser('listed', { googleSub: 'g-listed' });
    const adminCookie = await cookieLogin(`boss${D}`);
    const reset = await post(`/admin/users/${g.id}/reset-password`, undefined, withCookie(adminCookie));
    expect(reset.status).toBe(200);
    expect(reset.json.user).toMatchObject({ id: g.id, has_password: true, must_change_password: true, has_google: true });
    const r = await login(LISTED, reset.json.temp_password);
    const done = await post('/auth/password/complete', { change_token: r.json.change_token, new_password: GOOD });
    expect((await get('/me', withCookie(cookieOf(done.res)!))).json.id).toBe(g.id);
  });
});

// ---- admin ----------------------------------------------------------------------
describe('/admin/users', () => {
  let logs: string[] = [];
  let spies: ReturnType<typeof spyOn>[] = [];
  beforeEach(() => {
    logs = [];
    spies = (['log', 'warn', 'error', 'info'] as const).map((k) =>
      spyOn(console, k).mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(' '));
      }),
    );
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  dbTest('create, list, patch, reset, delete; temp passwords returned once and never logged', async () => {
    const admin = await makeUser('root', { role: 'admin', password: GOOD });
    const c = withCookie(await cookieLogin(`root${D}`));

    const created = await post('/admin/users', { email: `New.Person${D}`, name: 'New Person' }, { ...c, origin: ADMIN_ORIGIN });
    expect(created.status).toBe(201);
    expect(created.json.user).toMatchObject({ email: `new.person${D}`, name: 'New Person', role: 'user', status: 'active', has_password: true, must_change_password: true, has_google: false, signed_in_at: null });
    const temp = created.json.temp_password as string;
    const expires = Date.parse(created.json.user.temp_expires_at);
    expect(Math.abs(expires - (Date.now() + 7 * 86_400_000))).toBeLessThan(60_000);
    const hash = (await pool.query('select password_hash from public.user_passwords where user_id = $1', [created.json.user.id])).rows[0].password_hash;
    expect(hash).toStartWith('$argon2id$');
    expect(hash).not.toContain(temp);

    expect((await post('/admin/users', { email: `new.person${D}` }, c)).json.code).toBe('user_exists');

    const list = await get('/admin/users', c);
    expect(list.status).toBe(200);
    for (const row of list.json) adminUserSchema.parse(row);
    const emails = list.json.map((u: { email: string }) => u.email);
    expect(emails).toContain(`new.person${D}`);
    expect(emails).not.toContain('svc-budget-mcp@syscd.local');
    expect(emails).not.toContain('dev@localhost');
    expect(JSON.stringify(list.json)).not.toContain('argon2');

    const id = created.json.user.id as string;
    const patched = await post(`/admin/users/${id}`, { name: 'Renamed', role: 'admin', email: `hijack${D}` }, c, 'PATCH');
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ name: 'Renamed', role: 'admin', email: `new.person${D}` });
    expect((await post(`/admin/users/${id}`, { status: 'disabled' }, c, 'PATCH')).json.status).toBe('disabled');

    const reset = await post(`/admin/users/${id}/reset-password`, undefined, c);
    expect(reset.status).toBe(200);
    expect(reset.json.temp_password).not.toBe(temp);

    expect((await post(`/admin/users/${id}`, undefined, c, 'DELETE')).status).toBe(204);
    expect((await pool.query('select 1 from public.users where id = $1', [id])).rowCount).toBe(0);
    expect((await pool.query('select 1 from public.user_passwords where user_id = $1', [id])).rowCount).toBe(0);
    expect((await post(`/admin/users/${id}`, undefined, c, 'DELETE')).status).toBe(404);
    expect((await post(`/admin/users/${crypto.randomUUID()}`, { name: 'x' }, c, 'PATCH')).status).toBe(404);

    const all = logs.join('\n');
    expect(all).toContain('"action":"create"');
    expect(all).toContain('"action":"reset_password"');
    expect(all).toContain('"action":"delete"');
    expect(all).toContain(`"actor":"root${D}"`);
    for (const secret of [temp, reset.json.temp_password, GOOD, hash, '$argon2']) expect(all).not.toContain(secret);
    expect(admin.id).toBeTruthy();
  });

  dbTest('reset ends the user password sessions', async () => {
    await makeUser('root2', { role: 'admin', password: GOOD });
    const victim = await makeUser('victim', { password: GOOD });
    const c = withCookie(await cookieLogin(`root2${D}`));
    const v = await cookieLogin(`victim${D}`);
    expect((await get('/me', withCookie(v))).status).toBe(200);
    expect((await post(`/admin/users/${victim.id}/reset-password`, undefined, c)).status).toBe(200);
    expect((await get('/me', withCookie(v))).status).toBe(401);
  });

  dbTest('401 without a session; 403 for a non-admin, an admin OAuth token and the service token; 403 for a foreign Origin', async () => {
    const root = await makeUser('root3', { role: 'admin', password: GOOD });
    await makeUser('pleb', { password: GOOD });
    expect((await get('/admin/users')).status).toBe(401);
    const pleb = withCookie(await cookieLogin(`pleb${D}`));
    for (const [path, method, body] of [
      ['/admin/users', 'GET', undefined],
      ['/admin/users', 'POST', { email: `x${D}` }],
      [`/admin/users/${root.id}`, 'PATCH', { name: 'x' }],
      [`/admin/users/${root.id}/reset-password`, 'POST', undefined],
      [`/admin/users/${root.id}`, 'DELETE', undefined],
    ] as const) {
      const r = method === 'GET' ? await get(path, pleb) : await post(path, body, pleb, method);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    const tok = await grantToken(root.id, root.email, 'password');
    expect((await get('/admin/users', bearer(tok))).status).toBe(403);
    expect((await get('/admin/users', bearer(SVC_TOKEN))).status).toBe(403);
    const rootCookie = withCookie(await cookieLogin(`root3${D}`));
    expect((await post('/admin/users', { email: `x${D}` }, { ...rootCookie, origin: 'https://evil.syscd.live' })).json.code).toBe('origin_not_allowed');
  });

  dbTest('self guards, synthetic rows, delete refused with data, password login off', async () => {
    const root = await makeUser('root4', { role: 'admin', password: GOOD });
    const c = withCookie(await cookieLogin(`root4${D}`));
    expect((await post(`/admin/users/${root.id}`, { status: 'disabled' }, c, 'PATCH')).json.code).toBe('cannot_modify_self');
    expect((await post(`/admin/users/${root.id}`, { role: 'user' }, c, 'PATCH')).json.code).toBe('cannot_modify_self');
    expect((await post(`/admin/users/${root.id}`, undefined, c, 'DELETE')).json.code).toBe('cannot_modify_self');
    expect((await post(`/admin/users/${root.id}`, { name: 'Me' }, c, 'PATCH')).json.name).toBe('Me');

    const svc = await pool.query<{ id: string }>(
      `insert into public.users (id, email, google_sub) values (gen_random_uuid(), 'svc-budget-mcp@syscd.local', 'svc:budget-mcp')
       on conflict (email) do update set email = excluded.email returning id`,
    );
    expect((await post(`/admin/users/${svc.rows[0]!.id}`, { status: 'disabled' }, c, 'PATCH')).status).toBe(404);
    expect((await post(`/admin/users/${svc.rows[0]!.id}/reset-password`, undefined, c)).status).toBe(404);

    const owner = await makeUser('owner', { password: GOOD });
    await pool.query(`insert into public.budgets (id, name, owner_user_id) values (gen_random_uuid(), 'pw-owned', $1)`, [owner.id]);
    const del = await post(`/admin/users/${owner.id}`, undefined, c, 'DELETE');
    expect(del.status).toBe(409);
    expect(del.json.code).toBe('user_has_data');

    configureAuth({ ...CONFIG(), passwordLogin: false });
    // The admin's own password session is now invalid: use a Google-listed admin.
    await makeUser('listed', { role: 'admin', googleSub: 'g-listed-admin' });
    const g = withCookie(await issueSession(SECRET, LISTED, 60));
    expect((await post('/admin/users', { email: `late${D}` }, g)).json.code).toBe('password_login_disabled');
    expect((await post(`/admin/users/${owner.id}/reset-password`, undefined, g)).json.code).toBe('password_login_disabled');
    expect((await get('/admin/users', g)).status).toBe(200);
  });
});

// ---- OAuth consent with a password session -------------------------------------
describe('OAuth consent (oauth/authorize.ts) with a password session', () => {
  const REDIRECT = 'https://cb.test/callback';
  const hidden = (html: string) => {
    const out: Record<string, string> = {};
    for (const m of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) out[m[1]!] = m[2]!.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    return out;
  };
  async function startConsent(cookie: string) {
    const a = app();
    const reg = await a.request(`${API}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'pw consent', redirect_uris: [REDIRECT] }),
    });
    const client = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
    });
    const page = await a.request(`${API}/oauth/authorize?${q}`, { headers: withCookie(cookie) });
    return { a, page, clientId: client.client_id };
  }

  dbTest('approves with a valid password session; the grant remembers idp password', async () => {
    const u = await makeUser('consent', { password: GOOD });
    const c = await cookieLogin(`consent${D}`);
    const { a, page, clientId } = await startConsent(c);
    expect(page.status).toBe(200);
    const res = await a.request(`${API}/oauth/authorize`, {
      method: 'POST',
      headers: { ...withCookie(c), origin: API, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...hidden(await page.text()), decision: 'approve' }),
    });
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy();
    const g = await pool.query('select idp from public.oauth_grants where user_id = $1 and client_id = $2', [u.id, clientId]);
    expect(g.rows[0].idp).toBe('password');
  });

  dbTest('a password session for an unknown or stale account is sent to sign in, and no row is created', async () => {
    const phantom = await issueSession(SECRET, `consent-ghost${D}`, 60, 'password', 1);
    expect((await startConsent(phantom)).page.status).toBe(302);
    expect((await pool.query('select 1 from public.users where email = $1', [`consent-ghost${D}`])).rowCount).toBe(0);
    await makeUser('consent-stale', { password: GOOD });
    const stale = await issueSession(SECRET, `consent-stale${D}`, 60, 'password', 99);
    expect((await startConsent(stale)).page.status).toBe(302);
  });
});
