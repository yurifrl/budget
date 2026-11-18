/**
 * Tests for server/budget/routes/members.ts — budget sharing: list, add (existing
 * user / unknown email pre-provisioned / idempotent), owner-or-admin-only
 * management (404 for plain members and strangers), owner protected from
 * removal, removal revokes access.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from '@shared/zod';

import { dbReady } from '../../core/test-gate';
import { pool } from '../../core/db';
import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';
import accountsApp from './accounts';
import membersApp from './members';

const memberListSchema = z.array(
  z.object({
    user_id: z.string(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    is_owner: z.boolean(),
    is_me: z.boolean(),
    pending: z.boolean(),
    avatar: z.object({ seed: z.string(), image_version: z.number().nullable() }),
  }),
);
const listSchema = z.object({ members: memberListSchema, can_manage: z.boolean() });
const mutationSchema = z.object({ members: memberListSchema });

let currentUser: IdentityUser | undefined;
function mount(child: Hono) {
  const wrapper = new Hono();
  wrapper.onError(httpOnError);
  wrapper.use('*', (c, next) => {
    c.set('user', currentUser);
    return next();
  });
  wrapper.route('/', child);
  return wrapper;
}
const members = mount(membersApp);
const accounts = mount(accountsApp);

const mk = (tag: string) => ({
  id: crypto.randomUUID(),
  email: `mem-${tag}@members.test`,
  googleSub: null,
  role: 'user' as const,
  status: 'active' as const,
});
const owner = mk('owner');
const peer = mk('peer');
const stranger = mk('stranger');
const admin = { ...mk('admin'), role: 'admin' as const };
const invitedEmail = 'mem-invited@members.test';
const budgetId = crypto.randomUUID();
const json = { 'content-type': 'application/json' };

async function cleanup() {
  await pool.query(`DELETE FROM budgets WHERE name = 'members-test'`);
  await pool.query(`DELETE FROM public.users WHERE email LIKE 'mem-%@members.test'`);
}

if (dbReady) {
  await cleanup();
  for (const u of [owner, peer, stranger, admin]) {
    await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, $3)`, [u.id, u.email, u.role]);
  }
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'members-test', $2)`, [budgetId, owner.id]);
  await pool.query(`INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2)`, [budgetId, owner.id]);
}

afterAll(async () => {
  if (dbReady) await cleanup();
});

const list = () => members.request(`/?budget_id=${budgetId}`);
const add = (email: string, name?: string) =>
  members.request('/', { method: 'POST', headers: json, body: JSON.stringify({ budget_id: budgetId, email, name }) });
const post = (path: string, body: unknown) =>
  members.request(path, { method: 'POST', headers: json, body: JSON.stringify({ budget_id: budgetId, ...(body as object) }) });
const remove = (userId: string) =>
  members.request(`/?budget_id=${budgetId}&user_id=${userId}`, { method: 'DELETE' });

describe.skipIf(!dbReady)('budget members API', () => {
  test('owner lists members with is_owner and can_manage', async () => {
    currentUser = owner;
    const res = await list();
    expect(res.status).toBe(200);
    const body = listSchema.parse(await res.json());
    expect(body.can_manage).toBe(true);
    expect(body.members).toEqual([
      {
        user_id: owner.id,
        email: owner.email,
        name: null,
        is_owner: true,
        is_me: true,
        pending: true, // fixture rows are inserted without a signed_in_at
        avatar: { seed: owner.id, image_version: null },
      },
    ]);
  });

  test('is_me is relative to the viewer; a signed-in user is not pending', async () => {
    // Signed in through Cloudflare Access: no google_sub, ever.
    await pool.query(`UPDATE public.users SET signed_in_at = now() WHERE id = $1`, [peer.id]);
    currentUser = owner;
    await add(peer.email);
    const asOwner = listSchema.parse(await (await list()).json()).members;
    expect(asOwner.find((m) => m.user_id === owner.id)?.is_me).toBe(true);
    expect(asOwner.find((m) => m.user_id === peer.id)).toMatchObject({ is_me: false, pending: false });
    currentUser = peer;
    const asPeer = listSchema.parse(await (await list()).json()).members;
    expect(asPeer.map((m) => [m.user_id === peer.id, m.is_me])).toEqual([
      [false, false],
      [true, true],
    ]);
  });

  test('adds an existing user by email (case-insensitive) and is idempotent', async () => {
    currentUser = owner;
    const first = await add(peer.email.toUpperCase());
    expect(first.status).toBe(200);
    const again = await add(peer.email);
    expect(again.status).toBe(200);
    const body = mutationSchema.parse(await again.json());
    expect(body.members.map((m) => m.email)).toEqual([owner.email, peer.email]);
    expect(body.members.find((m) => m.user_id === peer.id)?.is_owner).toBe(false);
  });

  test('a plain member lists (can_manage=false), may add people, but cannot remove', async () => {
    currentUser = peer;
    const body = listSchema.parse(await (await list()).json());
    expect(body.can_manage).toBe(false);
    expect((await add('mem-byplain@members.test')).status).toBe(200); // grouping, not permission
    expect((await remove(owner.id)).status).toBe(404);
    // Members can use the budget's data too.
    expect((await accounts.request(`/?budget_id=${budgetId}`)).status).toBe(200);
  });

  test('a stranger gets 404 on list and add', async () => {
    currentUser = stranger;
    expect((await list()).status).toBe(404);
    expect((await add(stranger.email)).status).toBe(404);
  });

  test('an unknown email is pre-provisioned (role user, no google_sub) and added', async () => {
    currentUser = owner;
    const res = await add(` ${invitedEmail} `);
    expect(res.status).toBe(200);
    const row = await pool.query<{ id: string; role: string; google_sub: string | null }>(
      'SELECT id, role, google_sub FROM public.users WHERE email = $1',
      [invitedEmail],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].role).toBe('user');
    expect(row.rows[0].google_sub).toBeNull();
    const body = mutationSchema.parse(await res.json());
    expect(body.members.some((m) => m.user_id === row.rows[0].id)).toBe(true);
  });

  test('adding with a name sets it when the row has none, and never overwrites an existing one', async () => {
    currentUser = owner;
    const fresh = 'mem-named@members.test';
    const created = mutationSchema.parse(await (await add(fresh, '  Ana  ')).json());
    expect(created.members.find((m) => m.email === fresh)).toMatchObject({ name: 'Ana', pending: true });
    // Re-adding with another name leaves the first one alone.
    const again = mutationSchema.parse(await (await add(fresh, 'Someone Else')).json());
    expect(again.members.find((m) => m.email === fresh)?.name).toBe('Ana');
    // A user who already has a name keeps it.
    await pool.query('UPDATE public.users SET name = $2 WHERE id = $1', [peer.id, 'Real Peer']);
    const existing = mutationSchema.parse(await (await add(peer.email, 'Imposter')).json());
    expect(existing.members.find((m) => m.user_id === peer.id)?.name).toBe('Real Peer');
    // An existing row with no name gets filled.
    const filled = mutationSchema.parse(await (await add(owner.email, 'Olivia')).json());
    expect(filled.members.find((m) => m.user_id === owner.id)?.name).toBe('Olivia');
    expect((await add('mem-x@members.test', 'x'.repeat(81))).status).toBe(400);
  });

  test('first sign-in links the pre-provisioned row (same id, memberships kept)', async () => {
    const { resolveOrCreateSessionUser } = await import('../../user');
    const before = await pool.query<{ id: string }>('SELECT id FROM public.users WHERE email = $1', [invitedEmail]);
    const resolved = await resolveOrCreateSessionUser(invitedEmail, { sub: 'g-invited-sub', name: 'Invited' });
    expect(resolved.id).toBe(before.rows[0].id);
    currentUser = resolved;
    expect((await accounts.request(`/?budget_id=${budgetId}`)).status).toBe(200);
  });

  test('invalid input is 400', async () => {
    currentUser = owner;
    expect((await add('not-an-email')).status).toBe(400);
    expect((await members.request('/')).status).toBe(400);
  });

  test('the owner cannot be removed: 400 for the owner, 404 for a member and for an admin', async () => {
    currentUser = owner;
    expect((await remove(owner.id)).status).toBe(400);
    currentUser = peer;
    expect((await remove(owner.id)).status).toBe(404);
    currentUser = admin;
    expect((await remove(owner.id)).status).toBe(404);
    expect((await pool.query('SELECT owner_user_id FROM budgets WHERE id = $1', [budgetId])).rows[0].owner_user_id).toBe(owner.id);
  });

  test('removing a member nulls their accounts in that budget (others untouched)', async () => {
    currentUser = owner;
    const mkAccount = async (name: string, userId: string | null) => {
      const res = await accounts.request('/', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ budget_id: budgetId, name, type: 'checking', ...(userId ? { user_id: userId } : {}) }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const peerAcc = await mkAccount('peer acct', peer.id);
    const ownerAcc = await mkAccount('owner acct', owner.id);
    // A peer-assigned account in ANOTHER budget must survive the removal.
    const otherBudget = crypto.randomUUID();
    await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'members-test', $2)`, [otherBudget, owner.id]);
    await pool.query(`INSERT INTO accounts (budget_id, name, type, account_group, user_id) VALUES ($1, 'elsewhere', 'checking', 'CASH', $2)`, [otherBudget, peer.id]);

    // Their categories fall back to Shared too (and only in this budget).
    const groupId = (await pool.query<{ id: string }>(
      `INSERT INTO category_groups (budget_id, name) VALUES ($1, 'g') RETURNING id`, [budgetId])).rows[0].id;
    const peerCat = (await pool.query<{ id: string }>(
      `INSERT INTO categories (budget_id, group_id, name, user_id) VALUES ($1, $2, 'peer cat', $3) RETURNING id`,
      [budgetId, groupId, peer.id])).rows[0].id;
    const ownerCat = (await pool.query<{ id: string }>(
      `INSERT INTO categories (budget_id, group_id, name, user_id) VALUES ($1, $2, 'owner cat', $3) RETURNING id`,
      [budgetId, groupId, owner.id])).rows[0].id;
    const otherGroup = (await pool.query<{ id: string }>(
      `INSERT INTO category_groups (budget_id, name) VALUES ($1, 'g') RETURNING id`, [otherBudget])).rows[0].id;
    await pool.query(`INSERT INTO categories (budget_id, group_id, name, user_id) VALUES ($1, $2, 'elsewhere cat', $3)`, [otherBudget, otherGroup, peer.id]);

    // The peer's own bank is linked to one account here; the owner's bank to another.
    const conn = async (userId: string) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO connections (id, user_id, provider, external_id, status) VALUES (gen_random_uuid(), $1, 'members-test', gen_random_uuid()::text, 'connected') RETURNING id`,
        [userId])).rows[0].id;
    const [peerConn, ownerConn] = [await conn(peer.id), await conn(owner.id)];
    await pool.query(`UPDATE accounts SET connection_id = $2, external_account_id = 'ext-peer', institution = 'Peer Bank' WHERE id = $1`, [peerAcc, peerConn]);
    await pool.query(`UPDATE accounts SET connection_id = $2, external_account_id = 'ext-owner', institution = 'Owner Bank' WHERE id = $1`, [ownerAcc, ownerConn]);

    expect((await remove(peer.id)).status).toBe(200);
    // The removed person's bank no longer feeds this budget; the owner's link is untouched.
    const links = await pool.query<{ id: string; connection_id: string | null; external_account_id: string | null }>(
      'SELECT id, connection_id, external_account_id FROM accounts WHERE id = ANY($1)', [[peerAcc, ownerAcc]]);
    expect(links.rows.find((r) => r.id === peerAcc)).toMatchObject({ connection_id: null, external_account_id: null });
    expect(links.rows.find((r) => r.id === ownerAcc)).toMatchObject({ connection_id: ownerConn, external_account_id: 'ext-owner' });
    await pool.query('UPDATE accounts SET connection_id = NULL, external_account_id = NULL WHERE id = $1', [ownerAcc]);
    await pool.query('DELETE FROM connections WHERE id = ANY($1)', [[peerConn, ownerConn]]);
    const cats = await pool.query<{ id: string; user_id: string | null }>('SELECT id, user_id FROM categories WHERE id = ANY($1)', [[peerCat, ownerCat]]);
    expect(cats.rows.find((r) => r.id === peerCat)?.user_id).toBeNull();
    expect(cats.rows.find((r) => r.id === ownerCat)?.user_id).toBe(owner.id);
    expect((await pool.query('SELECT user_id FROM categories WHERE budget_id = $1', [otherBudget])).rows[0].user_id).toBe(peer.id);
    const rows = await pool.query<{ id: string; user_id: string | null }>(
      'SELECT id, user_id FROM accounts WHERE id = ANY($1)',
      [[peerAcc, ownerAcc]],
    );
    expect(rows.rows.find((r) => r.id === peerAcc)?.user_id).toBeNull();
    expect(rows.rows.find((r) => r.id === ownerAcc)?.user_id).toBe(owner.id);
    const elsewhere = await pool.query('SELECT user_id FROM accounts WHERE budget_id = $1', [otherBudget]);
    expect(elsewhere.rows[0].user_id).toBe(peer.id);
  });

  test('removing a member revokes access; only the owner can remove', async () => {
    await pool.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [budgetId, peer.id]);
    // A member cannot remove anyone (not even themselves), an admin who is not on the budget cannot either.
    currentUser = peer;
    expect((await remove(peer.id)).status).toBe(404);
    currentUser = admin;
    expect((await remove(peer.id)).status).toBe(404);
    expect((await pool.query('SELECT 1 FROM public.budget_members WHERE budget_id = $1 AND user_id = $2', [budgetId, peer.id])).rowCount).toBe(1);
    currentUser = owner;
    // peer was already removed above; re-add so this test still exercises removal.
    await pool.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [budgetId, peer.id]);
    const res = await remove(peer.id);
    expect(res.status).toBe(200);
    expect(mutationSchema.parse(await res.json()).members.some((m) => m.user_id === peer.id)).toBe(false);
    currentUser = peer;
    expect((await accounts.request(`/?budget_id=${budgetId}`)).status).toBe(404);
  });

  test('listMembers includes the owner without a member row', async () => {
    const lone = crypto.randomUUID();
    await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'members-test', $2)`, [lone, owner.id]);
    currentUser = owner;
    const body = listSchema.parse(await (await members.request(`/?budget_id=${lone}`)).json());
    expect(body.members.map((m) => [m.user_id, m.is_owner, m.is_me])).toEqual([[owner.id, true, true]]);
  });

  test('a budget with no owner yet is closed to everyone, admin included, until it is claimed', async () => {
    const unowned = crypto.randomUUID();
    await pool.query(`INSERT INTO budgets (id, name) VALUES ($1, 'members-test')`, [unowned]);
    for (const who of [admin, owner, stranger]) {
      currentUser = who;
      expect((await members.request(`/?budget_id=${unowned}`)).status).toBe(404);
    }
    await pool.query('DELETE FROM budgets WHERE id = $1', [unowned]);
  });

  describe('placeholder people', () => {
    const phAccount = async (userId: string, name: string) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO accounts (budget_id, name, type, account_group, user_id) VALUES ($1, $2, 'checking', 'CASH', $3) RETURNING id`,
        [budgetId, name, userId],
      )).rows[0].id;

    test('add by name only creates an email-less, non-signed-in person; name is required', async () => {
      currentUser = owner;
      expect((await post('/', {})).status).toBe(400);
      const res = await post('/', { name: '  Gabriele  ' });
      expect(res.status).toBe(200);
      const ph = mutationSchema.parse(await res.json()).members.find((m) => m.name === 'Gabriele');
      expect(ph).toMatchObject({ email: null, pending: true, is_owner: false });
      const row = await pool.query('SELECT role, google_sub, email FROM public.users WHERE id = $1', [ph!.user_id]);
      expect(row.rows[0]).toEqual({ role: 'user', google_sub: null, email: null });
      // The DB refuses an unnamed placeholder.
      await expect(pool.query(`INSERT INTO public.users (id, email) VALUES (gen_random_uuid(), NULL)`)).rejects.toThrow();
    });

    test('rename works for unclaimed people, not for signed-in ones', async () => {
      await pool.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [budgetId, peer.id]);
      currentUser = peer;
      const ph = mutationSchema.parse(await (await post('/', { name: 'Old' })).json()).members.find((m) => m.name === 'Old')!;
      const ok = await members.request('/', { method: 'PATCH', headers: json, body: JSON.stringify({ budget_id: budgetId, user_id: ph.user_id, name: 'New' }) });
      expect(ok.status).toBe(200);
      expect(mutationSchema.parse(await ok.json()).members.some((m) => m.name === 'New')).toBe(true);
      await pool.query(`UPDATE public.users SET signed_in_at = now() WHERE id = $1`, [owner.id]);
      const no = await members.request('/', { method: 'PATCH', headers: json, body: JSON.stringify({ budget_id: budgetId, user_id: owner.id, name: 'Hax' }) });
      expect(no.status).toBe(400);
    });

    test('link a free email: the placeholder becomes a pre-provisioned user', async () => {
      currentUser = owner;
      const ph = mutationSchema.parse(await (await post('/', { name: 'Free' })).json()).members.find((m) => m.name === 'Free')!;
      const res = await post('/link-email', { user_id: ph.user_id, email: ' Mem-Free@Members.test ' });
      expect(res.status).toBe(200);
      const m = mutationSchema.parse(await res.json()).members.find((x) => x.user_id === ph.user_id);
      expect(m).toMatchObject({ email: 'mem-free@members.test', name: 'Free', pending: true });
      // Linking again: it already has an email.
      expect((await post('/link-email', { user_id: ph.user_id, email: 'mem-other@members.test' })).status).toBe(400);
    });

    test('link an existing email merges: accounts, categories, memberships repointed; placeholder deleted', async () => {
      currentUser = owner;
      const target = mk('merge-target');
      await pool.query(`INSERT INTO public.users (id, email, name) VALUES ($1, $2, NULL)`, [target.id, target.email]);
      const ph = mutationSchema.parse(await (await post('/', { name: 'Merge Me' })).json()).members.find((m) => m.name === 'Merge Me')!;
      // The target is already a member too (conflicting membership row).
      await pool.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2)', [budgetId, target.id]);
      const acc = await phAccount(ph.user_id, 'merged acct');
      const group = (await pool.query<{ id: string }>(`INSERT INTO category_groups (budget_id, name) VALUES ($1, 'mg') RETURNING id`, [budgetId])).rows[0].id;
      const cat = (await pool.query<{ id: string }>(
        `INSERT INTO categories (budget_id, group_id, name, user_id) VALUES ($1, $2, 'merged cat', $3) RETURNING id`, [budgetId, group, ph.user_id])).rows[0].id;
      // Membership in a second budget the target is not in: must move over.
      const other = crypto.randomUUID();
      await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'members-test', $2)`, [other, owner.id]);
      await pool.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2)', [other, ph.user_id]);

      const res = await post('/link-email', { user_id: ph.user_id, email: target.email });
      expect(res.status).toBe(200);
      const list = mutationSchema.parse(await res.json()).members;
      expect(list.some((m) => m.user_id === ph.user_id)).toBe(false);
      expect(list.filter((m) => m.user_id === target.id)).toHaveLength(1);
      expect((await pool.query('SELECT user_id FROM accounts WHERE id = $1', [acc])).rows[0].user_id).toBe(target.id);
      expect((await pool.query('SELECT user_id FROM categories WHERE id = $1', [cat])).rows[0].user_id).toBe(target.id);
      expect((await pool.query('SELECT user_id FROM public.budget_members WHERE budget_id = $1', [other])).rows.map((r) => r.user_id)).toContain(target.id);
      expect((await pool.query('SELECT 1 FROM public.users WHERE id = $1', [ph.user_id])).rowCount).toBe(0);
      expect((await pool.query('SELECT name FROM public.users WHERE id = $1', [target.id])).rows[0].name).toBe('Merge Me');
    });

    test('merge covers every FK to users (catalog-discovered), so new FKs cannot be missed', async () => {
      const { userReferenceColumns } = await import('../../user');
      const cols = (await userReferenceColumns()).map((c) => `${c.table}.${c.column}`);
      expect(cols).toContain('public.accounts.user_id');
      expect(cols).toContain('public.categories.user_id');
      expect(cols).toContain('public.budget_members.user_id');
      expect(cols).toContain('public.budgets.owner_user_id');
    });

    test('a placeholder can never sign in', async () => {
      const { resolveOrCreateSessionUser, isAllowed } = await import('../../user');
      const before = await pool.query('SELECT count(*)::int AS n FROM public.users WHERE email IS NULL');
      const u = await resolveOrCreateSessionUser('mem-signin-probe@members.test', { sub: 'g-probe' });
      expect(u.email).toBe('mem-signin-probe@members.test');
      const after = await pool.query('SELECT count(*)::int AS n FROM public.users WHERE email IS NULL');
      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(isAllowed('')).toBe(false);
    });
  });
});
