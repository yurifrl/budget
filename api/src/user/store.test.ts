import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';

import { issueSession } from './auth';
import { authMiddleware } from './authz';
import { pool } from '../core/db';
import { requireAdmin, requireUser } from './middleware';
import { dbReady } from '../core/test-gate';
import { resolveOrCreateSessionUser } from './store';
import { configureAuth } from './config';

// Store/middleware behavior is DB-backed, and this suite wipes public.users
// — it may only run against the throwaway test database, never a shared dev
// DB, so the gate demands the preload's isolation marker.
let reachable = dbReady;

const SECRET = 'x'.repeat(32);

/** Gated app with the real gate + identity chain (no route modules). */
function gatedApp() {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.use('*', requireUser);
  app.get('/me', (c) => c.json(c.get('user')));
  app.get('/admin', requireAdmin, (c) => c.json({ ok: true }));
  return app;
}

/** Dev-bypass app: no authMiddleware in front (the machine has no session). */
function devApp() {
  const app = new Hono();
  app.use('*', requireUser);
  app.get('/me', (c) => c.json(c.get('user')));
  return app;
}

const COOKIE = 'budget_session';

const countUsers = async (): Promise<number> => {
  const r = await pool.query<{ n: number }>('select count(*)::int as n from public.users');
  return r.rows[0].n;
};

const findUser = async (email: string) => {
  const r = await pool.query<{
    email: string;
    google_sub: string | null;
    role: string;
    status: string;
    last_seen_at: string;
  }>('select email, google_sub, role, status, last_seen_at from public.users where email = $1', [
    email,
  ]);
  return r.rows[0] ?? null;
};

beforeEach(async () => {
  // Test-managed DB state: every case starts from an empty users table.
  // Empty-table precondition without TRUNCATE: budgets.owner_user_id (0013)
  // FKs users, and TRUNCATE is blocked by the reference even with zero rows.
  // Detach ownership first, then delete; unowned budgets are re-claimed on
  // the next real sign-in (USER-04), so this never loses data.
  if (reachable) {
    await pool.query('alter table public.budgets alter column owner_user_id drop not null');
    await pool.query(
      'update public.budgets set owner_user_id = null where owner_user_id in (select id from public.users)',
    );
    await pool.query('delete from public.users');
  }
  // authz.test.ts's beforeEach leaks auth envs across files (single test
  // process); the dev bypass requires them absent, so delete explicitly.
  configureAuth({ authDisabled: true });
});

describe.skipIf(!reachable)('users bootstrap (first-admin seeding)', () => {
  it('(a) fresh row shape: the first-ever allowlisted sign-in provisions admin', async () => {
    expect(await countUsers()).toBe(0);
    const user = await resolveOrCreateSessionUser('  First@X.com  ', { sub: 'sub-first' });
    expect(user.role).toBe('admin');
    expect(user.email).toBe('first@x.com');
    expect(user.googleSub).toBe('sub-first');
    expect(user.status).toBe('active');
    const row = await findUser('first@x.com');
    expect(row?.role).toBe('admin');
  });

  it('(b) bootstrap-only: every later first-sight email provisions role user', async () => {
    await resolveOrCreateSessionUser('first@x.com', { sub: 'sub-first' });
    const second = await resolveOrCreateSessionUser('second@x.com', { sub: 'sub-second' });
    expect(second.role).toBe('user');
    const row = await findUser('second@x.com');
    expect(row?.role).toBe('user');
  });
});

describe.skipIf(!reachable)('JIT provisioning (criterion 1)', () => {
  it('(c) idempotence: same row on repeat, last_seen_at advances, sub preserved', async () => {
    await resolveOrCreateSessionUser('first@x.com', { sub: 'sub-first' });
    const provisioned = await resolveOrCreateSessionUser('newuser@x.com', {
      sub: 'sub-new',
      name: 'New User',
    });
    expect(provisioned.role).toBe('user');
    const resolved = await resolveOrCreateSessionUser('newuser@x.com');
    expect(resolved.id).toBe(provisioned.id);

    // Repeat request (per-request callers pass no identity — old cookies
    // carry no sub) must advance last_seen_at without a row count change.
    await pool.query(`update public.users set last_seen_at = '2020-01-01' where email = 'newuser@x.com'`);
    const after = await resolveOrCreateSessionUser('newuser@x.com');
    const row = await findUser('newuser@x.com');
    expect(row).not.toBeNull();
    expect(Date.parse(row!.last_seen_at) > Date.parse('2020-01-01T00:00:00Z')).toBe(true);
    expect(after.id).toBe(provisioned.id);
    expect(await countUsers()).toBe(2);
  });

  it('(d) identity-less repeat never backfills a null over an existing sub', async () => {
    await resolveOrCreateSessionUser('first@x.com', { sub: 'sub-first' });
    await resolveOrCreateSessionUser('backfill@x.com', { sub: 'sub-b' });
    // Frozen JWT shape (D-01): legacy principal-less cookies carry { email }
    // only — the store must coalesce, never overwrite google_sub with null.
    const again = await resolveOrCreateSessionUser('backfill@x.com', { sub: null, name: 'Renamed' });
    expect(again.googleSub).toBe('sub-b');
    const row = await findUser('backfill@x.com');
    expect(row?.google_sub).toBe('sub-b');
    expect(again.name).toBe('Renamed');
  });
});

describe.skipIf(!reachable)('gated chain (criterion 2: per-request authority reads)', () => {
  it('(e) role/status resolve from the DB on every request — no restart, no cache', async () => {
    configureAuth({ sessionSecret: SECRET, allowedEmails: ['admin-seed@x.com', 'user@x.com'] });
    await resolveOrCreateSessionUser('admin-seed@x.com');
    await resolveOrCreateSessionUser('user@x.com');
    const app = gatedApp();
    const token = await issueSession(SECRET, 'user@x.com', 60);
    const headers = { cookie: `${COOKIE}=${token}` };

    const denied = await app.request('/admin', { headers });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden' });

    await pool.query(`update public.users set role = 'admin' where email = 'user@x.com'`);
    const promoted = await app.request('/admin', { headers });
    expect(promoted.status).toBe(200);

    await pool.query(`update public.users set role = 'user' where email = 'user@x.com'`);
    const demoted = await app.request('/admin', { headers });
    expect(demoted.status).toBe(403);

    const me = await app.request('/me', { headers });
    expect(me.status).toBe(200);
    expect((await me.json()).role).toBe('user');
  });

  it('401s a cookie-less request at the gate', async () => {
    configureAuth({ sessionSecret: SECRET, allowedEmails: ['admin-seed@x.com', 'user@x.com'] });
    const app = gatedApp();
    const res = await app.request('/me');
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!reachable)('dev bypass (criterion 3)', () => {
  it('(f) provisions exactly one synthetic admin row across repeated requests', async () => {
    const app = devApp();
    const first = await app.request('/me');
    expect(first.status).toBe(200);
    const user = await first.json();
    expect(user.email).toBe('dev@localhost');
    expect(user.role).toBe('admin');
    expect(user.status).toBe('active');

    const second = await app.request('/me');
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe(user.id);

    const row = await findUser('dev@localhost');
    expect(row?.google_sub).toBe('dev:local');
    expect(row?.role).toBe('admin');
    expect(await countUsers()).toBe(1);
  });

  it('keeps the dev row admin in every dev-DB state (idempotent promote)', async () => {
    await devApp().request('/me');
    // Any prior DB state (e.g. a manual demotion) is corrected on the next
    // request — the bypassed machine has no other authority.
    await pool.query(`update public.users set role = 'user' where email = 'dev@localhost'`);
    const res = await devApp().request('/me');
    expect(res.status).toBe(200);
    expect((await res.json()).role).toBe('admin');
  });

  it('is unreachable when auth is configured: cookie-less request 401s', async () => {
    configureAuth({ googleClientId: 'cid', sessionSecret: SECRET, allowedEmails: ['a@b.com'] });
    try {
      const res = await devApp().request('/me');
      expect(res.status).toBe(401);
      expect(await countUsers()).toBe(0);
    } finally {
      configureAuth({ authDisabled: true });
    }
  });
});

describe.skipIf(!reachable)('concurrency + allowlist persistence (criterion 4: bootstrap fires at most once, DB roles survive env churn)', () => {
  it('(g) allowlist env changes never rewrite DB roles — per-request authority reads the DB', async () => {
    await resolveOrCreateSessionUser('role@x.com', { sub: 'sub-role' });
    // A role change made outside the env (member store / SQL) is authority.
    await pool.query(`update public.users set role = 'admin' where email = 'role@x.com'`);
    // Removing the email from the allowlist must not demote or re-provision:
    // roles are DB-authoritative, not env-authoritative.
    configureAuth({ authDisabled: true, allowedEmails: ['other@x.com'] });
    const resolved = await resolveOrCreateSessionUser('role@x.com');
    expect(resolved.role).toBe('admin');
    expect(await countUsers()).toBe(1);
  });

  it('(h) concurrent first sign-ins converge: exactly one row, exactly one admin', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolveOrCreateSessionUser('conc@x.com', { sub: 'sub-conc' })),
    );
    // The advisory lock + insert-on-conflict serialize the bootstrap: one row
    // ever exists, so the admin slot can never be split across candidates.
    expect(await countUsers()).toBe(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results[0].role).toBe('admin');
    expect(results[0].googleSub).toBe('sub-conc');
  });

  it('(i) concurrent mixed lanes (identity + identity-less) never split the row', async () => {
    const lanes = Array.from({ length: 8 }, (_, i) =>
      i % 2
        ? resolveOrCreateSessionUser('mix@x.com', { sub: 'sub-mix' })
        : resolveOrCreateSessionUser('mix@x.com'),
    );
    const results = await Promise.all(lanes);
    expect(await countUsers()).toBe(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const row = await findUser('mix@x.com');
    expect(row?.google_sub).toBe('sub-mix');
    // Whichever lane inserts first, the bootstrap promotes exactly that row.
    expect(row?.role).toBe('admin');
  });
});
