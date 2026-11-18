/**
 * Tests for category ownership (categories.user_id): create / set-person /
 * set-group-person accept a budget member (or null = Shared) and 400 for
 * anyone else; the list returns user_id.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { pool } from '../../core/db';
import { dbReady } from '../../core/test-gate';
import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';
import categoriesApp from './categories';

const mk = (tag: string): IdentityUser => ({
  id: crypto.randomUUID(),
  email: `cat-${tag}@catperson.test`,
  googleSub: null,
  role: 'user',
  status: 'active',
});
const owner = mk('owner');
const member = mk('member');
const outsider = mk('outsider');
const budgetId = crypto.randomUUID();
const groupId = crypto.randomUUID();
const otherGroupId = crypto.randomUUID();
const json = { 'content-type': 'application/json' };

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', owner);
  return next();
});
app.route('/', categoriesApp);

type Row = { id: string; name: string; user_id: string | null };
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async () => (await (await app.request(`/?budget_id=${budgetId}`)).json()) as Row[];

async function cleanup() {
  await pool.query(`DELETE FROM budgets WHERE name = 'cat-person-test'`);
  await pool.query(`DELETE FROM public.users WHERE email LIKE 'cat-%@catperson.test'`);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  for (const u of [owner, member, outsider]) {
    await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, 'user')`, [u.id, u.email]);
  }
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'cat-person-test', $2)`, [budgetId, owner.id]);
  await pool.query(`INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2), ($1, $3)`, [budgetId, owner.id, member.id]);
  await pool.query(
    `INSERT INTO category_groups (id, budget_id, name, sort_order) VALUES ($1, $3, 'G1', 0), ($2, $3, 'G2', 1)`,
    [groupId, otherGroupId, budgetId],
  );
});

afterAll(async () => {
  if (dbReady) await cleanup();
});

describe.skipIf(!dbReady)('categories.user_id (person)', () => {
  test('create defaults to Shared (null)', async () => {
    const res = await send('POST', '/', { budget_id: budgetId, group_id: groupId, name: 'Plain', sort_order: 0 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row).user_id).toBeNull();
  });

  test('create with a member / the owner is accepted and returned by the list', async () => {
    const a = await send('POST', '/', { budget_id: budgetId, group_id: groupId, name: 'Mine', sort_order: 1, user_id: member.id });
    expect(((await a.json()) as Row).user_id).toBe(member.id);
    const b = await send('POST', '/', { budget_id: budgetId, group_id: groupId, name: 'Owner cat', sort_order: 2, user_id: owner.id });
    expect(((await b.json()) as Row).user_id).toBe(owner.id);
    const rows = await list();
    expect(rows.find((r) => r.name === 'Mine')?.user_id).toBe(member.id);
  });

  test('create with a non-member is 400 and writes nothing', async () => {
    const res = await send('POST', '/', { budget_id: budgetId, group_id: groupId, name: 'Nope', sort_order: 3, user_id: outsider.id });
    expect(res.status).toBe(400);
    expect((await list()).some((r) => r.name === 'Nope')).toBe(false);
  });

  test('set-person assigns, clears, and rejects non-members', async () => {
    const cat = (await list()).find((r) => r.name === 'Plain')!;
    const set = (user_id: string | null) => send('PATCH', `/${cat.id}/person?budget_id=${budgetId}`, { user_id });
    expect((await set(member.id)).status).toBe(204);
    expect((await list()).find((r) => r.id === cat.id)?.user_id).toBe(member.id);
    expect((await set(null)).status).toBe(204);
    expect((await list()).find((r) => r.id === cat.id)?.user_id).toBeNull();
    expect((await set(outsider.id)).status).toBe(400);
    expect((await send('PATCH', `/${crypto.randomUUID()}/person?budget_id=${budgetId}`, { user_id: null })).status).toBe(404);
  });

  test('set-group-person assigns every category of that group only', async () => {
    const other = await send('POST', '/', { budget_id: budgetId, group_id: otherGroupId, name: 'Elsewhere', sort_order: 0 });
    const otherId = ((await other.json()) as Row).id;
    const res = await send('PATCH', `/group-person?budget_id=${budgetId}`, { group_id: groupId, user_id: member.id });
    expect(res.status).toBe(204);
    const rows = await list();
    for (const name of ['Plain', 'Mine', 'Owner cat']) expect(rows.find((r) => r.name === name)?.user_id).toBe(member.id);
    expect(rows.find((r) => r.id === otherId)?.user_id).toBeNull();
    expect((await send('PATCH', `/group-person?budget_id=${budgetId}`, { group_id: groupId, user_id: outsider.id })).status).toBe(400);
    expect((await send('PATCH', `/group-person?budget_id=${budgetId}`, { group_id: crypto.randomUUID(), user_id: null })).status).toBe(404);
  });
});
