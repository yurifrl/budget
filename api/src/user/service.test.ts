import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono, type Context } from 'hono';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { requireAdmin, requireUser } from './middleware';
import { resolveServiceUser } from './store';

const countUsers = async (): Promise<number> => {
  const { rows } = await pool.query<{ n: number }>('select count(*)::int as n from public.users');
  return rows[0].n;
};

import { configureAuth } from './config';

const SECRET = 'x'.repeat(32);
const TOKEN = 't'.repeat(32);

// Store/middleware behavior is DB-backed, and the beforeEach below wipes
// public.users — it may only run against the throwaway test database, never
// a shared dev DB, so the gate demands the preload's isolation marker.
let reachable = dbReady;

beforeEach(async () => {
  // Empty-table precondition without TRUNCATE: budgets.owner_user_id (0013)
  // FKs users, and TRUNCATE is blocked by the reference even with zero rows.
  // Detach ownership first, then delete; unowned budgets are re-claimed on
  // the next real sign-in (USER-04), so this never loses data.
  if (!reachable) return;
  await pool.query('alter table public.budgets alter column owner_user_id drop not null');
  await pool.query(
    'update public.budgets set owner_user_id = null where owner_user_id in (select id from public.users)',
  );
  await pool.query('delete from public.users');
});

/** Auth-ON state: session gate active, dev bypass unreachable. */
function authOn() {
  configureAuth({ googleClientId: 'cid', sessionSecret: SECRET, allowedEmails: ['user@x.com'] });
}

function authOnWithToken() {
  configureAuth({ authDisabled: true, serviceToken: TOKEN });
}

function authOff() {
  configureAuth({ authDisabled: true });
}

/** Minimal request context: resolveServiceUser reads only the bearer header. */
const ctxWithBearer = (auth?: string) =>
  ({
    req: { header: (name: string) => (name === 'Authorization' ? auth : undefined) },
  }) as Context;

/** Identity-only app (no gate): requireUser's own empty-identity predicate. */
function requireUserApp() {
  const app = new Hono();
  app.use('*', requireUser);
  app.get('/me', (c) => c.json(c.get('user')));
  app.get('/admin', requireAdmin, (c) => c.json({ ok: true }));
  return app;
}

describe.skipIf(!reachable)('service bearer lane (criterion 4: one persisted svc row)', () => {
  it('(a) first valid bearer provisions once; second call resolves the same row', async () => {
    authOnWithToken();
    try {
      const first = await resolveServiceUser(ctxWithBearer(`Bearer ${TOKEN}`));
      expect(first).not.toBeNull();
      const second = await resolveServiceUser(ctxWithBearer(`Bearer ${TOKEN}`));
      expect(second!.id).toBe(first!.id);
      expect(await countUsers()).toBe(1);
    } finally {
      authOff();
    }
  });

  it('(b) role is user from the start — never admin, even as first row', async () => {
    authOnWithToken();
    try {
      const svc = await resolveServiceUser(ctxWithBearer(`Bearer ${TOKEN}`));
      expect(svc!.role).toBe('user');
    } finally {
      authOff();
    }
  });

  it('(c) wrong token value → null, zero rows created', async () => {
    authOnWithToken();
    try {
      const svc = await resolveServiceUser(ctxWithBearer(`Bearer ${'w'.repeat(32)}`));
      expect(svc).toBeNull();
      expect(await countUsers()).toBe(0);
    } finally {
      authOff();
    }
  });

  it('(d) valid token but OT_SERVICE_TOKEN unset → null, zero rows', async () => {
    try {
      const svc = await resolveServiceUser(ctxWithBearer(`Bearer ${TOKEN}`));
      expect(svc).toBeNull();
      expect(await countUsers()).toBe(0);
    } finally {
      authOff();
    }
  });

  it('(e) empty identity (no principal, no bearer, auth configured) → 401, row count unchanged', async () => {
    authOn();
    try {
      const res = await requireUserApp().request('/me');
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('unauthorized');
      expect(await countUsers()).toBe(0);
    } finally {
      authOff();
    }
  });
});
