/**
 * Tests for the composition root's public pre-gate: `/health` must report the
 * release version the entrypoint injected, so the app's /stats page can show
 * which API build it is talking to. Pure `app.request()` — no listener, no DB.
 */
import { describe, expect, test } from 'bun:test';

import { buildApp } from './app';

describe('GET /health', () => {
  test('reports the injected release version', async () => {
    const app = buildApp({
      appOrigin: 'https://test.local',
      version: '2026.11.08',
    });

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '2026.11.08' });
  });
});

describe('CORS', () => {
  const preflight = (origin: string, adminOrigins?: string[]) =>
    buildApp({ appOrigin: 'https://test.local', adminOrigins, version: 't' }).request('/health', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
    });

  test('allows the configured admin origin with credentials', async () => {
    const res = await preflight('https://budget-admin.syscd.live', ['https://budget-admin.syscd.live']);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://budget-admin.syscd.live');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  test('does not allow an unconfigured origin', async () => {
    const res = await preflight('https://budget-admin.syscd.live');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Everything after the gate enforces account status like requireUser.
// ---------------------------------------------------------------------------
import { afterAll, beforeEach } from 'bun:test';

import { pool } from './core/db';
import { dbReady } from './core/test-gate';
import { issueSession } from './user/auth';
import { configureAuth } from './user/config';
import { resolveOrCreateSessionUser } from './user/store';

const SECRET = 'x'.repeat(32);

function authOn() {
  configureAuth({
    googleClientId: 'cid',
    sessionSecret: SECRET,
    allowedEmails: ['active@x.com', 'off@x.com'],
  });
}

afterAll(() => {
  configureAuth({ authDisabled: true });
});

const dbTest = test.skipIf(!dbReady);
const app = () => buildApp({ appOrigin: 'https://test.local', version: 't' });
const cookie = async (email: string) => ({ cookie: `budget_session=${await issueSession(SECRET, email, 60)}` });

describe('the gate enforces account status', () => {
  beforeEach(async () => {
    authOn();
    if (!dbReady) return;
    await resolveOrCreateSessionUser('active@x.com');
    await resolveOrCreateSessionUser('off@x.com');
    await pool.query(`update public.users set status = 'active' where email = 'active@x.com'`);
    await pool.query(`update public.users set status = 'disabled' where email = 'off@x.com'`);
  });

  dbTest('disabled user is rejected with 401 account disabled', async () => {
    const res = await app().request('/rates', { headers: await cookie('off@x.com') });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'account disabled', code: 'account_disabled' });
  });

  dbTest('active user passes the gate', async () => {
    const res = await app().request('/rates', { headers: await cookie('active@x.com') });
    expect(res.status).not.toBe(401);
  });

  test('no credential / unknown bearer stays 401 unauthorized', async () => {
    for (const h of [{}, { authorization: 'Bearer nope' }] as Record<string, string>[]) {
      const res = await app().request('/rates', { headers: h });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized', code: 'unauthorized' });
    }
  });

  test('a syscd_session cookie is not a Budget session', async () => {
    const token = await issueSession(SECRET, 'active@x.com', 60);
    const res = await app().request('/rates', { headers: { cookie: `syscd_session=${token}` } });
    expect(res.status).toBe(401);
  });

  test('fail-closed default: an unconfigured process refuses everything', async () => {
    configureAuth({});
    expect((await app().request('/rates')).status).toBe(401);
    expect((await app().request('/auth/me')).status).toBe(401);
  });

  test('explicit authDisabled opens the API (local dev)', async () => {
    configureAuth({ authDisabled: true });
    const res = await app().request('/auth/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'dev@localhost' });
  });
});
