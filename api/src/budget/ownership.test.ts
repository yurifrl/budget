/**
 * Tests for server/budget/ownership.ts + server/budget/routes/budgets.ts — Phase 2
 * ownership semantics (USER-03/04/05): owner-or-admin scoping with 404
 * (never 403) for cross-owner access, claim-on-first-login (transactional,
 * idempotent, orphan rows unowned-until-claimed), admin bypass, and the
 * service lane (no principal → never claims).
 *
 * Route exercised IN-PROCESS via app.request() with a stubbed identity —
 * production runs behind requireUser, which guarantees the identity. The
 * guard is stateless (never writes); claiming happens only at GET
 * /budgets, so live non-fixture budgets can only be reassigned there.
 * Cleanup snapshots their owners before the run and restores them.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { z } from '@shared/zod';

import type { IdentityUser } from '../user';
import { authConfig, configureAuth } from '../user';

const budgetListSchema = z.array(z.object({ id: z.string(), name: z.string() }));
const errorBodySchema = z.object({ error: z.string() });
const createdAccountSchema = z.object({ id: z.string() });

let pool: Pool | null = null;
let dbReady = false;

const accountsApp = (await import('./routes/accounts')).default;
const budgetsApp = (await import('./routes/budgets')).default;

const { Hono } = await import('hono');
const { httpOnError } = await import('../core/validate');

const app = new Hono();
app.onError(httpOnError);

/** Mutable stub identity — each test swaps the user before issuing a request. */
let currentUser: IdentityUser | undefined;
let hasPrincipal = false;
/** Extra principal claims (grantId/scope) — set to mimic an OAuth access token. */
let principalExtra: { scope?: string; grantId?: string } = {};
/** Principal email is kept separate so the 401 test can have a principal
 * but no resolved user without dereferencing undefined. */
let principalEmail = 'stub@ownership.test';

function mount(child: InstanceType<typeof Hono>) {
  const wrapper = new Hono();
  wrapper.onError(httpOnError);
  wrapper.use('*', (c, next) => {
    c.set('user', currentUser);
    c.set('principal', hasPrincipal ? { email: principalEmail, ...principalExtra } : undefined);
    return next();
  });
  wrapper.route('/', child);
  return wrapper;
}

const accounts = mount(accountsApp);
const budgets = mount(budgetsApp);

const owner = {
  id: crypto.randomUUID(),
  email: 'own-owner@ownership.test',
  googleSub: null,
} as const;
const intruder = {
  id: crypto.randomUUID(),
  email: 'own-intruder@ownership.test',
  googleSub: null,
} as const;
const admin = {
  id: crypto.randomUUID(),
  email: 'own-admin@ownership.test',
  googleSub: null,
} as const;

const member = {
  id: crypto.randomUUID(),
  email: 'own-member@ownership.test',
  googleSub: null,
} as const;

const ownedBudget = crypto.randomUUID();
const intrudersBudget = crypto.randomUUID();
const orphanBudget = crypto.randomUUID();
const orphanBudget2 = crypto.randomUUID();

async function insertUser(id: string, email: string, role: 'user' | 'admin') {
  await pool!.query(
    `INSERT INTO public.users (id, google_sub, email, role, status)
     VALUES ($1, null, $2, $3, 'active')`,
    [id, email, role],
  );
}

async function insertBudget(id: string, name: string, ownerId: string | null) {
  await pool!.query(
    'INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)',
    [id, name, ownerId],
  );
}

async function countUnowned(): Promise<number> {
  const { rows } = await pool!.query<{ count: string }>(
    'SELECT count(*) FROM budgets WHERE owner_user_id IS NULL',
  );
  return Number(rows[0].count);
}

/** Owner_user_id snapshot of every non-fixture budget, for restore. */
let liveOwners: { id: string; owner: string | null }[] = [];

// Top-level (not beforeAll): describe.skipIf must observe dbReady at
// collection time, before any hook runs.
try {
  pool = (await import('../core/db')).pool;
  await (await import('../core/migrate')).runMigrations();
  dbReady = true;

  // Self-heal stale rows from a previously crashed run (ids are per-run
  // random; emails and budget names are the stable keys).
  await cleanFixtures();
  await dropNotNull();

  await insertUser(owner.id, owner.email, 'user');
  await insertUser(intruder.id, intruder.email, 'user');
  await insertUser(admin.id, admin.email, 'admin');
  await insertUser(member.id, member.email, 'user');

  await insertBudget(ownedBudget, 'ownership-owned', owner.id);
  await insertBudget(intrudersBudget, 'ownership-intruders', intruder.id);
  await insertBudget(orphanBudget, 'ownership-orphan', null);
  await insertBudget(orphanBudget2, 'ownership-orphan-2', null);

  liveOwners = (
    await pool.query<{ id: string; owner: string | null }>(
      `SELECT id, owner_user_id AS owner FROM budgets WHERE name NOT LIKE 'ownership-%'`,
    )
  ).rows;
} catch (err) {
  console.error('[ownership.test] DB setup failed:', err instanceof Error ? err.message : err);
  dbReady = false;
}

/** Deletes every fixture row (by stable email/name keys), oldest refs first. */
async function cleanFixtures() {
  await pool!.query(
    `DELETE FROM budgets b USING public.users u
      WHERE b.owner_user_id = u.id AND u.email = ANY($1)`,
    [[owner.email, intruder.email, admin.email, member.email]],
  );
  await pool!.query(`DELETE FROM budgets WHERE name LIKE 'ownership-%'`);
  await pool!.query('DELETE FROM public.users WHERE email = ANY($1)', [
    [owner.email, intruder.email, admin.email],
  ]);
}

/**
 * The column starts nullable and is finalized NOT NULL by claimUnownedBudgets
 * once zero unowned rows remain — including on this live dev DB. Tests
 * exercise the pre-finalize phase, so they drop the constraint for their
 * duration and re-apply it on the way out when cleanup leaves no orphans.
 */
async function dropNotNull() {
  await pool!.query('ALTER TABLE public.budgets ALTER COLUMN owner_user_id DROP NOT NULL');
}

async function restoreNotNull() {
  const { rows } = await pool!.query<{ count: string }>(
    'SELECT count(*) FROM public.budgets WHERE owner_user_id IS NULL',
  );
  if (Number(rows[0].count) === 0) {
    await pool!.query('ALTER TABLE public.budgets ALTER COLUMN owner_user_id SET NOT NULL');
  }
}

afterAll(async () => {
  if (!dbReady || !pool) return;
  // Restore the owners the claim test may have reassigned (the guard itself
  // is stateless; only GET /budgets sweeps unowned rows globally).
  await pool.query('ALTER TABLE public.budgets ALTER COLUMN owner_user_id DROP NOT NULL');
  for (const row of liveOwners) {
    await pool.query('UPDATE budgets SET owner_user_id = $2 WHERE id = $1', [row.id, row.owner]);
  }
  await cleanFixtures();
  await restoreNotNull();
});

describe.skipIf(!dbReady)('budget route ownership (Phase 2, USER-04/05)', () => {
  test('claims unowned budgets on first sign-in, idempotently', async () => {
    // Re-orphan the two fixture budgets: a previous run's claim may have
    // finalized the column, and this test needs the pre-finalize phase.
    await dropNotNull();
    await pool!.query(
      'UPDATE budgets SET owner_user_id = NULL WHERE id = ANY($1)',
      [[orphanBudget, orphanBudget2]],
    );
    // An unowned budget has no members (claiming is what creates the first).
    await pool!.query('DELETE FROM public.budget_members WHERE budget_id = ANY($1)', [
      [orphanBudget, orphanBudget2],
    ]);
    const before = await countUnowned();
    expect(before).toBeGreaterThanOrEqual(2);

    // First real sign-in (session principal) claims every orphan.
    currentUser = { ...owner, role: 'user', status: 'active' };
    hasPrincipal = true;
    const first = await budgets.request('/', { method: 'GET' });
    expect(first.status).toBe(200);
    const list = budgetListSchema.parse(await first.json());
    expect(list.some((b) => b.id === ownedBudget)).toBe(true);
    expect(list.some((b) => b.id === orphanBudget)).toBe(true);

    const after = await countUnowned();
    // The claim sweep takes EVERY unowned budget (fixture orphans and any
    // live unowned rows alike), so the table ends with zero orphans.
    expect(after).toBe(0);

    // Finalize: only when the sweep leaves zero unowned rows does the
    // column become NOT NULL (USER-04 end state).
    if (after === 0) {
      const col = await pool!.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'budgets'
            AND column_name = 'owner_user_id'`,
      );
      expect(col.rows[0].is_nullable).toBe('NO');
    }

    // Idempotent: re-listing claims nothing, ownership unchanged.
    await budgets.request('/', { method: 'GET' });
    const still = await pool!.query<{ owner_user_id: string | null }>(
      'SELECT owner_user_id FROM budgets WHERE id = $1',
      [orphanBudget],
    );
    expect(still.rows[0].owner_user_id).toBe(owner.id);
  });

  test('owner reads own budget; cross-owner read is 404, not 403', async () => {
    currentUser = { ...owner, role: 'user', status: 'active' };
    hasPrincipal = true;

    const own = await accounts.request(`/?budget_id=${ownedBudget}`);
    expect(own.status).toBe(200);
    expect(Array.isArray(await own.json())).toBe(true);

    const foreign = await accounts.request(`/?budget_id=${intrudersBudget}`);
    expect(foreign.status).toBe(404);
    expect(errorBodySchema.parse(await foreign.json()).error).toBe('not found');
  });

  test('cross-owner write is 404; write ownership comes from the identity, never the body', async () => {
    currentUser = { ...owner, role: 'user', status: 'active' };
    hasPrincipal = true;

    const res = await accounts.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        budget_id: intrudersBudget,
        name: 'Smuggled Account',
        type: 'checking',
        on_budget: true,
        balance_cents: 0,
      }),
    });
    expect(res.status).toBe(404);

    const none = await pool!.query(
      "SELECT 1 FROM accounts WHERE name = 'Smuggled Account'",
    );
    expect(none.rowCount).toBe(0);
  });

  test('guard authorizes every budget_id carried: query=mine + body=foreign is 404 (no cross-tenant write)', async () => {
    currentUser = { ...owner, role: 'user', status: 'active' };
    hasPrincipal = true;

    const res = await accounts.request(`/?budget_id=${ownedBudget}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        budget_id: intrudersBudget,
        name: 'Split Id Account',
        type: 'checking',
        on_budget: true,
        balance_cents: 0,
      }),
    });
    expect(res.status).toBe(404);
    expect(errorBodySchema.parse(await res.json()).error).toBe('not found');
    const none = await pool!.query("SELECT 1 FROM accounts WHERE name = 'Split Id Account'");
    expect(none.rowCount).toBe(0);

    // Same id in both places stays fine.
    const ok = await accounts.request(`/?budget_id=${ownedBudget}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: ownedBudget, name: 'Same Id Account', type: 'checking', on_budget: true, balance_cents: 0 }),
    });
    expect(ok.status).toBe(201);
    await pool!.query('DELETE FROM accounts WHERE id = $1', [createdAccountSchema.parse(await ok.json()).id]);
  });

  test('admin bypasses ownership on read and write', async () => {
    currentUser = { ...admin, role: 'admin', status: 'active' };
    hasPrincipal = true;

    const read = await accounts.request(`/?budget_id=${intrudersBudget}`);
    expect(read.status).toBe(200);

    const write = await accounts.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        budget_id: intrudersBudget,
        name: 'Admin Bypass Account',
        type: 'checking',
        on_budget: true,
        balance_cents: 0,
      }),
    });
    expect(write.status).toBe(201);
    const created = createdAccountSchema.parse(await write.json());
    await pool!.query('DELETE FROM accounts WHERE id = $1', [created.id]);
  });

  test('unowned budget is unowned-until-claimed: first claimer wins, the next is locked out', async () => {
    // Re-orphan both budgets: the first test claimed them, and that claim
    // may have finalized NOT NULL — reset both.
    await dropNotNull();
    await pool!.query(
      'UPDATE budgets SET owner_user_id = NULL WHERE id = ANY($1)',
      [[orphanBudget, orphanBudget2]],
    );
    // An unowned budget has no members (claiming is what creates the first).
    await pool!.query('DELETE FROM public.budget_members WHERE budget_id = ANY($1)', [
      [orphanBudget, orphanBudget2],
    ]);

    // The first session human to list budgets claims; here that is the
    // intruder — the claim is blind, it sweeps everything unowned.
    currentUser = { ...intruder, role: 'user', status: 'active' };
    hasPrincipal = true;
    const claim = await budgets.request('/', { method: 'GET' });
    expect(claim.status).toBe(200);
    expect(
      budgetListSchema.parse(await claim.json()).some((b) => b.id === orphanBudget),
    ).toBe(true);

    // The next claimer is locked out of the now-owned budget.
    currentUser = { ...owner, role: 'user', status: 'active' };
    const lockedOut = await accounts.request(`/?budget_id=${orphanBudget}`);
    expect(lockedOut.status).toBe(404);
  });

  test('dev bypass (auth off, dev user, no principal) claims unowned budgets: owner + member', async () => {
    await dropNotNull();
    await pool!.query('UPDATE budgets SET owner_user_id = NULL WHERE id = $1', [orphanBudget]);
    await pool!.query('DELETE FROM public.budget_members WHERE budget_id = $1', [orphanBudget]);
    const dev = await pool!.query<{ id: string }>(
      `INSERT INTO public.users (id, email, role) VALUES (gen_random_uuid(), 'dev@localhost', 'admin')
       ON CONFLICT (email) DO UPDATE SET role = 'admin' RETURNING id`,
    );
    currentUser = { id: dev.rows[0].id, email: 'dev@localhost', googleSub: 'dev:local', role: 'admin', status: 'active' };
    hasPrincipal = false;
    principalExtra = {};
    // Auth unconfigured = dev bypass (other suites may leave auth env set).
    const saved = authConfig();
    configureAuth({ authDisabled: true });
    let res: Response;
    try {
      res = await budgets.request('/', { method: 'GET' });
    } finally {
      configureAuth(saved);
    }
    expect(res.status).toBe(200);
    const row = await pool!.query('SELECT owner_user_id FROM budgets WHERE id = $1', [orphanBudget]);
    expect(row.rows[0].owner_user_id).toBe(dev.rows[0].id);
    const member = await pool!.query('SELECT 1 FROM public.budget_members WHERE budget_id = $1 AND user_id = $2', [orphanBudget, dev.rows[0].id]);
    expect(member.rowCount).toBe(1);
    // Hand the fixtures back so later tests start from known ownership.
    await pool!.query('DELETE FROM public.budget_members WHERE user_id = $1', [dev.rows[0].id]);
    await pool!.query('UPDATE budgets SET owner_user_id = $2 WHERE owner_user_id = $1', [dev.rows[0].id, owner.id]);
    await pool!.query(`DELETE FROM public.users WHERE id = $1`, [dev.rows[0].id]);
  });

  test('service lane (no session principal) never claims and sees only owned budgets', async () => {
    currentUser = { id: crypto.randomUUID(), email: 'svc-budget-mcp@syscd.local', googleSub: 'svc:budget-mcp', role: 'user', status: 'active' };
    hasPrincipal = false;

    const before = await countUnowned();
    const res = await budgets.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(await countUnowned()).toBe(before);
  });

  test.each(['read', 'read write'])('OAuth access token (scope "%s") never claims and sees only owned budgets', async (scope) => {
    await dropNotNull();
    await pool!.query('UPDATE budgets SET owner_user_id = NULL WHERE id = $1', [orphanBudget]);
    await pool!.query('DELETE FROM public.budget_members WHERE budget_id = $1', [orphanBudget]);
    const stillUnowned = await countUnowned();
    currentUser = { ...owner, role: 'user', status: 'active' };
    hasPrincipal = true;
    principalExtra = { scope, grantId: crypto.randomUUID() };
    try {
      const res = await budgets.request('/', { method: 'GET' });
      expect(res.status).toBe(200);
      const list = budgetListSchema.parse(await res.json());
      expect(list.some((b) => b.id === ownedBudget)).toBe(true);
      expect(list.some((b) => b.id === intrudersBudget)).toBe(false);
      expect(list.some((b) => b.id === orphanBudget)).toBe(false);
      expect(await countUnowned()).toBe(stillUnowned);
      expect(stillUnowned).toBeGreaterThanOrEqual(1);
    } finally {
      principalExtra = {};
    }
  });

  test('missing identity is 401', async () => {
    currentUser = undefined as unknown as IdentityUser;
    hasPrincipal = true;
    const res = await accounts.request(`/?budget_id=${ownedBudget}`);
    expect(res.status).toBe(401);
  });

  describe('budget members (sharing)', () => {
    const memberUser = { ...member, role: 'user' as const, status: 'active' as const };
    const freshStart = () =>
      budgets.request('/fresh-start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ budget_id: ownedBudget }),
      });

    test('a member reads and writes the shared budget; removal revokes access', async () => {
      await pool!.query(
        'INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [ownedBudget, member.id],
      );
      currentUser = memberUser;
      hasPrincipal = true;

      expect((await accounts.request(`/?budget_id=${ownedBudget}`)).status).toBe(200);
      const list = budgetListSchema.parse(await (await budgets.request('/')).json());
      expect(list.some((b) => b.id === ownedBudget)).toBe(true);
      expect(list.some((b) => b.id === intrudersBudget)).toBe(false);

      await pool!.query('DELETE FROM public.budget_members WHERE budget_id = $1 AND user_id = $2', [
        ownedBudget,
        member.id,
      ]);
      expect((await accounts.request(`/?budget_id=${ownedBudget}`)).status).toBe(404);
    });

    test('a non-member of someone else\'s budget gets 404 even when a member elsewhere', async () => {
      await pool!.query(
        'INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [ownedBudget, member.id],
      );
      currentUser = memberUser;
      hasPrincipal = true;
      expect((await accounts.request(`/?budget_id=${intrudersBudget}`)).status).toBe(404);
    });

    test('a member cannot fresh-start, rename, archive or delete the budget', async () => {
      await pool!.query(
        'INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [ownedBudget, member.id],
      );
      currentUser = memberUser;
      hasPrincipal = true;

      expect((await freshStart()).status).toBe(404);
      const json = { 'content-type': 'application/json' };
      expect(
        (await budgets.request(`/${ownedBudget}`, { method: 'PATCH', headers: json, body: JSON.stringify({ name: 'x' }) })).status,
      ).toBe(404);
      expect((await budgets.request(`/${ownedBudget}/archive`, { method: 'POST' })).status).toBe(404);
      expect((await budgets.request(`/${ownedBudget}`, { method: 'DELETE' })).status).toBe(404);
      const still = await pool!.query('SELECT archived_at FROM budgets WHERE id = $1 AND name = $2', [ownedBudget, 'ownership-owned']);
      expect(still.rows[0]?.archived_at).toBeNull();
    });

    test('fresh-start carries the member set to the replacement budget', async () => {
      currentUser = { ...owner, role: 'user', status: 'active' };
      hasPrincipal = true;
      const res = await freshStart();
      expect(res.status).toBe(200);
      const { created } = z.object({ created: z.object({ id: z.string() }) }).parse(await res.json());
      const members = await pool!.query<{ user_id: string }>(
        'SELECT user_id FROM public.budget_members WHERE budget_id = $1',
        [created.id],
      );
      expect(members.rows.map((r) => r.user_id).sort()).toEqual([owner.id, member.id].sort());
      await pool!.query('DELETE FROM budgets WHERE id = $1', [created.id]);
    });
  });
});
