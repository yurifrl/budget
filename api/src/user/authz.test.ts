import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';

import { issueSession } from './auth';
import { configureAuth } from './config';
import { serviceTokenMatches } from './authz';
import { pool } from '../core/db';
import { resolveOrCreateSessionUser } from './store';

// Capture tests are DB-backed (they provision real rows); skip cleanly
// without a DB, mirroring server/user/store.test.ts.
let dbReachable = true;
try {
  await pool.query('select 1');
} catch {
  dbReachable = false;
}

const SECRET = 'x'.repeat(32);

/**
 * Cleans the rows these tests create without a full-table TRUNCATE: budgets
 * now reference users (0013 owner_user_id FK), so `truncate public.users`
 * is no longer legal. Deleting the test emails is exact; demoting admins
 * restores the empty-table precondition of the first-admin seed promote
 * (dev's admin is re-promoted by the dev bypass on its next request).
 */
async function resetTestUsers() {
  await pool.query(`delete from public.users where email in ('a@b.com', 'intruder@evil.com')`);
  await pool.query(`update public.users set role = 'user' where role = 'admin'`);
}

function loadAuthz() {
  return import('./authz?' + Math.random());
}

describe('isAllowed', () => {
  beforeEach(() => {
    configureAuth({ sessionSecret: SECRET, allowedEmails: ['a@b.com', 'c@d.com'], googleClientId: 'cid' });
  });

  it('matches case-insensitively and trims', async () => {
    const { isAllowed } = await loadAuthz();
    expect(isAllowed('A@B.com')).toBe(true);
    expect(isAllowed('c@d.com')).toBe(true);
    expect(isAllowed('x@y.com')).toBe(false);
  });

  it('denies everyone when the allowlist is empty', async () => {
    configureAuth({ sessionSecret: SECRET, allowedEmails: [], googleClientId: 'cid' });
    const { isAllowed } = await loadAuthz();
    expect(isAllowed('a@b.com')).toBe(false);
  });
});

describe('authMiddleware', () => {
  beforeEach(() => {
    configureAuth({ sessionSecret: SECRET, allowedEmails: ['a@b.com'], googleClientId: 'cid' });
  });

  async function app() {
    const { authMiddleware } = await loadAuthz();
    const a = new Hono();
    a.use('*', authMiddleware);
    a.get('/ping', (c) => c.json({ ok: true }));
    return a;
  }

  it('401s without a session cookie', async () => {
    const res = await (await app()).request('/ping');
    expect(res.status).toBe(401);
  });

  it('200s with a valid session for an allowed email', async () => {
    const token = await issueSession(SECRET, 'a@b.com', 60);
    const res = await (await app()).request('/ping', { headers: { cookie: `budget_session=${token}` } });
    expect(res.status).toBe(200);
  });

  it('401s with a valid session for a NON-allowed email', async () => {
    const token = await issueSession(SECRET, 'intruder@evil.com', 60);
    const res = await (await app()).request('/ping', { headers: { cookie: `budget_session=${token}` } });
    expect(res.status).toBe(401);
  });
});

describe('native token flow', () => {
  beforeEach(async () => {
    // The /auth/token exchange now round-trips a DB capture (USER-01), so
    // stale rows from earlier runs poison the A5 collision predicate.
    await resetTestUsers();
    configureAuth({
      sessionSecret: SECRET,
      allowedEmails: ['a@b.com'],
      googleClientId: 'cid',
      googleClientSecret: 'csec',
      apiBaseUrl: 'https://api.test',
    });
  });

  async function routes() {
    const { mountAuthRoutes } = await loadAuthz();
    const app = new Hono();
    mountAuthRoutes(app);
    return app;
  }

  it('accepts exp:// and budgetapp:// but not the syscdapp:// scheme', async () => {
    const app = await routes();
    expect((await app.request('/auth/google/native?redirect_uri=budgetapp://login')).status).toBe(302);
    expect((await app.request('/auth/google/native?redirect_uri=syscdapp://login')).status).toBe(400);
  });

  it('rejects a non-allowlisted app redirect_uri at the start route', async () => {
    const res = await (await routes()).request('/auth/google/native?redirect_uri=https://evil.example');
    expect(res.status).toBe(400);
  });

  it('points the Google redirect at the server callback, carrying the app URI in state', async () => {
    const res = await (await routes()).request('/auth/google/native?redirect_uri=exp://192.168.1.5:8081');
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toContain(encodeURIComponent('https://api.test/auth/google/native/callback'));
    expect(location).toContain(encodeURIComponent('exp://192.168.1.5:8081|'));
  });

  it('forwards the code to the app with an HMAC ticket over the nonce', async () => {
    const res = await (await routes()).request(
      '/auth/google/native/callback?code=good&state=' +
        encodeURIComponent('budgetapp://login|nonce-1'),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const ticket = createHmac('sha256', SECRET).update('nonce-1').digest('base64url');
    expect(location).toBe(`budgetapp://login?code=good&state=nonce-1.${encodeURIComponent(ticket)}`);
  });

  it('exchanges code+state for a session token, rejecting a forged state', async () => {
    mock.module('./google', () => ({
      googleConfigured: () => true,
      googleAuthUrl: (redirect: string, state: string) =>
        `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}`,
      exchangeCode: async (code: string) =>
        code === 'good' ? { email: 'a@b.com', emailVerified: true, sub: 'sub-1' } : null,
    }));

    const app = await routes();

    const forged = await app.request(`/auth/token?code=good&state=${encodeURIComponent('nonce-2.deadbeef')}`);
    expect(forged.status).toBe(400);

    const nonce = 'nonce-3';
    const ticket = createHmac('sha256', SECRET).update(nonce).digest('base64url');
    const ok = await app.request(`/auth/token?code=good&state=${encodeURIComponent(`${nonce}.${ticket}`)}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { token: string; email: string };
    expect(body.email).toBe('a@b.com');

    const me = await app.request('/auth/me', { headers: { authorization: `Bearer ${body.token}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ email: 'a@b.com' });

    const intruder = await issueSession(SECRET, 'intruder@evil.com', 60);
    const denied = await app.request('/auth/me', { headers: { authorization: `Bearer ${intruder}` } });
    expect(denied.status).toBe(401);
  });
});

describe('serviceTokenMatches (hermes bearer)', () => {
  const TOKEN = 'hermes-service-token-0123456789abcdef';

  it('accepts the configured token and denies everything else', () => {
    configureAuth({ serviceToken: TOKEN });
    expect(serviceTokenMatches(TOKEN)).toBe(true);
    expect(serviceTokenMatches('wrong-token')).toBe(false);
    expect(serviceTokenMatches(`${TOKEN}-extended`)).toBe(false);
    expect(serviceTokenMatches('')).toBe(false);
  });

  it('is disabled when the token env is unset', () => {
    configureAuth({});
    expect(serviceTokenMatches('anything')).toBe(false);
  });
});

describe.skipIf(!dbReachable)('sign-in capture (criterion 5: identity lands at sign-in, A5 rejects collisions)', () => {
  beforeEach(async () => {
    await resetTestUsers();
    configureAuth({
      sessionSecret: SECRET,
      allowedEmails: ['a@b.com'],
      googleClientId: 'cid',
      googleClientSecret: 'csec',
      apiBaseUrl: 'https://api.test',
      appOrigin: 'https://app.test',
    });
  });

  async function routes() {
    const { mountAuthRoutes } = await loadAuthz();
    const app = new Hono();
    mountAuthRoutes(app);
    return app;
  }

  function rowFor(email: string) {
    return pool.query<{ google_sub: string | null; name: string | null; role: string }>(
      'select google_sub, name, role from public.users where email = $1',
      [email],
    );
  }

  it('captures google_sub + name into public.users at the web callback', async () => {
    mock.module('./google', () => ({
      googleConfigured: () => true,
      googleAuthUrl: (redirect: string, state: string) => `https://g.test?redirect_uri=${redirect}&state=${state}`,
      exchangeCode: async () =>
        ({ email: 'a@b.com', name: 'Captured', sub: 'sub-cap', emailVerified: true }),
    }));
    const res = await (await routes()).request('/auth/google/callback?code=good&state=state-1', {
      headers: { cookie: 'g_state=state-1' },
    });
    expect(res.status).toBe(302);
    const { rows } = await rowFor('a@b.com');
    expect(rows[0]?.google_sub).toBe('sub-cap');
    expect(rows[0]?.name).toBe('Captured');
    // First human sign-in on an empty table bootstraps the admin seed
    // (criterion 4: capture rides the seed-eligible human lane).
    expect(rows[0]?.role).toBe('admin');
  });

  it('A5 web: a cross-email sub collision at the callback 403s, never merges rows', async () => {
    await resolveOrCreateSessionUser('a@b.com', { sub: 'sub-other' });
    mock.module('./google', () => ({
      googleConfigured: () => true,
      googleAuthUrl: (redirect: string, state: string) => `https://g.test?redirect_uri=${redirect}&state=${state}`,
      exchangeCode: async () =>
        ({ email: 'a@b.com', sub: 'sub-cap', emailVerified: true }),
    }));
    const res = await (await routes()).request('/auth/google/callback?code=good&state=state-1', {
      headers: { cookie: 'g_state=state-1' },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('already provisioned');
    const { rows } = await rowFor('a@b.com');
    expect(rows[0]?.google_sub).toBe('sub-other');
  });

  it('A5 native: a sub collision at /auth/token 403s with a JSON error', async () => {
    await resolveOrCreateSessionUser('a@b.com', { sub: 'sub-other' });
    mock.module('./google', () => ({
      googleConfigured: () => true,
      googleAuthUrl: (redirect: string, state: string) => `https://g.test?redirect_uri=${redirect}&state=${state}`,
      exchangeCode: async () =>
        ({ email: 'a@b.com', sub: 'sub-cap', emailVerified: true }),
    }));
    const app = await routes();
    const nonce = 'cap-nonce';
    const ticket = createHmac('sha256', SECRET).update(nonce).digest('base64url');
    const res = await app.request(
      `/auth/token?code=good&state=${encodeURIComponent(`${nonce}.${ticket}`)}`,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'email already provisioned', code: 'forbidden' });
    const { rows } = await rowFor('a@b.com');
    expect(rows[0]?.google_sub).toBe('sub-other');
  });
});
