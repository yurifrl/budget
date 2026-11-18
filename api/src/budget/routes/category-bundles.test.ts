/**
 * Tests for category bundles: create / rename / delete / set_bundle, the
 * bundle.group_id = category.group_id invariant, cross-group joins, and the
 * pruning of emptied bundles via reorder and category delete.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { pool } from '../../core/db';
import { dbReady } from '../../core/test-gate';
import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';
import bundlesApp from './category-bundles';
import categoriesApp from './categories';

const owner: IdentityUser = {
  id: crypto.randomUUID(),
  email: 'bundles-owner@bundles.test',
  googleSub: null,
  role: 'user',
  status: 'active',
};
const budgetId = crypto.randomUUID();
const g1 = crypto.randomUUID();
const g2 = crypto.randomUUID();
const cat = (): string => crypto.randomUUID();
const [a, b, c, d, e] = [cat(), cat(), cat(), cat(), cat()];
const json = { 'content-type': 'application/json' };

const app = new Hono();
app.onError(httpOnError);
app.use('*', (ctx, next) => {
  ctx.set('user', owner);
  return next();
});
app.route('/bundles', bundlesApp);
app.route('/categories', categoriesApp);

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
type Bundle = { id: string; group_id: string; name: string };
type Cat = { id: string; group_id: string; bundle_id: string | null };
const bundles = async () => (await (await app.request(`/bundles?budget_id=${budgetId}`)).json()) as Bundle[];
const cats = async () => (await (await app.request(`/categories?budget_id=${budgetId}`)).json()) as Cat[];
const byId = async (id: string) => (await cats()).find((x) => x.id === id)!;

/** The invariant under test: every bundled category sits in its bundle's group. */
async function expectInvariant() {
  const bs = new Map((await bundles()).map((x) => [x.id, x.group_id]));
  for (const x of await cats()) if (x.bundle_id) expect(bs.get(x.bundle_id)).toBe(x.group_id);
  // and no bundle is empty
  const used = new Set((await cats()).map((x) => x.bundle_id));
  for (const id of bs.keys()) expect(used.has(id)).toBe(true);
}

async function cleanup() {
  await pool.query(`DELETE FROM budgets WHERE name = 'bundles-test'`);
  await pool.query(`DELETE FROM public.users WHERE email = 'bundles-owner@bundles.test'`);
}

async function reset() {
  await pool.query('DELETE FROM category_bundles WHERE budget_id = $1', [budgetId]);
  await pool.query('DELETE FROM categories WHERE budget_id = $1', [budgetId]);
  const rows: [string, string, number][] = [[a, g1, 0], [b, g1, 1], [c, g1, 2], [d, g2, 0], [e, g2, 1]];
  for (const [id, g, i] of rows) {
    await pool.query(`INSERT INTO categories (id, budget_id, group_id, name, sort_order) VALUES ($1, $2, $3, $4, $5)`, [id, budgetId, g, `c-${i}`, i]);
  }
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, 'user')`, [owner.id, owner.email]);
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'bundles-test', $2)`, [budgetId, owner.id]);
  await pool.query(`INSERT INTO category_groups (id, budget_id, name, sort_order) VALUES ($1, $3, 'G1', 0), ($2, $3, 'G2', 1)`, [g1, g2, budgetId]);
});
afterAll(async () => {
  if (dbReady) await cleanup();
});

describe.skipIf(!dbReady)('category bundles', () => {
  test('create needs >= 2 distinct categories and sets bundle_id', async () => {
    await reset();
    expect((await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'X', category_ids: [a, a] })).status).toBe(400);
    expect((await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'X', category_ids: [a] })).status).toBe(400);
    const res = await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'Medicines', category_ids: [a, b] });
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as Bundle;
    expect((await byId(a)).bundle_id).toBe(bundle.id);
    expect((await byId(c)).bundle_id).toBeNull();
    expect(await bundles()).toHaveLength(1);
    await expectInvariant();
  });

  test('create with a category of another group moves it into the group', async () => {
    await reset();
    const res = await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'M', category_ids: [a, d] });
    const bundle = (await res.json()) as Bundle;
    expect((await byId(d)).group_id).toBe(g1);
    expect((await byId(d)).bundle_id).toBe(bundle.id);
    await expectInvariant();
  });

  test('create 404s for unknown group or category and writes nothing', async () => {
    await reset();
    expect((await send('POST', '/bundles', { budget_id: budgetId, group_id: crypto.randomUUID(), name: 'M', category_ids: [a, b] })).status).toBe(404);
    expect((await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'M', category_ids: [a, crypto.randomUUID()] })).status).toBe(404);
    expect(await bundles()).toHaveLength(0);
    expect((await byId(a)).bundle_id).toBeNull();
  });

  test('rename, and delete (ungroup) keeps the categories', async () => {
    await reset();
    const bundle = (await (await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'M', category_ids: [a, b] })).json()) as Bundle;
    expect((await send('PATCH', `/bundles/${bundle.id}/name?budget_id=${budgetId}`, { name: 'Meds' })).status).toBe(204);
    expect((await bundles())[0].name).toBe('Meds');
    expect((await send('PATCH', `/bundles/${crypto.randomUUID()}/name?budget_id=${budgetId}`, { name: 'x' })).status).toBe(404);
    expect((await send('DELETE', `/bundles/${bundle.id}?budget_id=${budgetId}`)).status).toBe(204);
    expect(await bundles()).toHaveLength(0);
    expect((await byId(a)).bundle_id).toBeNull();
    expect(await cats()).toHaveLength(5);
    expect((await send('DELETE', `/bundles/${bundle.id}?budget_id=${budgetId}`)).status).toBe(404);
  });

  test('set_bundle joins a bundle, moving a category from another group', async () => {
    await reset();
    const bundle = (await (await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'M', category_ids: [a, b] })).json()) as Bundle;
    expect((await send('PATCH', `/bundles/categories?budget_id=${budgetId}`, { category_ids: [d], bundle_id: bundle.id })).status).toBe(204);
    expect((await byId(d)).group_id).toBe(g1);
    expect((await byId(d)).bundle_id).toBe(bundle.id);
    await expectInvariant();
  });

  test('removing the last categories deletes the bundle', async () => {
    await reset();
    await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'M', category_ids: [a, b] });
    await send('PATCH', `/bundles/categories?budget_id=${budgetId}`, { category_ids: [a, b], bundle_id: null });
    expect(await bundles()).toHaveLength(0);
    await expectInvariant();
  });

  test('moving the only categories to another bundle prunes the old one', async () => {
    await reset();
    const m1 = (await (await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'M1', category_ids: [a, b] })).json()) as Bundle;
    const m2 = (await (await send('POST', '/bundles', { budget_id: budgetId, group_id: g2, name: 'M2', category_ids: [d, e] })).json()) as Bundle;
    await send('PATCH', `/bundles/categories?budget_id=${budgetId}`, { category_ids: [a, b], bundle_id: m2.id });
    const left = await bundles();
    expect(left.map((x) => x.id)).toEqual([m2.id]);
    expect(left.some((x) => x.id === m1.id)).toBe(false);
    expect((await byId(a)).group_id).toBe(g2);
    await expectInvariant();
  });

  test('set_bundle 404s for an unknown bundle or category', async () => {
    await reset();
    expect((await send('PATCH', `/bundles/categories?budget_id=${budgetId}`, { category_ids: [a], bundle_id: crypto.randomUUID() })).status).toBe(404);
    expect((await send('PATCH', `/bundles/categories?budget_id=${budgetId}`, { category_ids: [crypto.randomUUID()], bundle_id: null })).status).toBe(404);
  });

  test('reorder to another group clears bundle_id and prunes an emptied bundle', async () => {
    await reset();
    const bundle = (await (await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'M', category_ids: [a, b, c] })).json()) as Bundle;
    await send('PATCH', `/categories/reorder?budget_id=${budgetId}`, { moves: [{ id: a, group_id: g2, sort_order: 5 }] });
    expect((await byId(a)).bundle_id).toBeNull();
    expect((await byId(b)).bundle_id).toBe(bundle.id);
    await send('PATCH', `/categories/reorder?budget_id=${budgetId}`, { moves: [{ id: b, group_id: g2, sort_order: 6 }] });
    expect(await bundles()).toHaveLength(1); // c still inside
    await send('PATCH', `/categories/reorder?budget_id=${budgetId}`, { moves: [{ id: c, group_id: g2, sort_order: 7 }] });
    expect(await bundles()).toHaveLength(0);
    await expectInvariant();
  });

  test('reorder inside the group keeps the bundle', async () => {
    await reset();
    await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'M', category_ids: [a, b] });
    await send('PATCH', `/categories/reorder?budget_id=${budgetId}`, { moves: [{ id: a, group_id: g1, sort_order: 9 }] });
    expect((await byId(a)).bundle_id).not.toBeNull();
  });

  test('deleting categories deletes an emptied bundle', async () => {
    await reset();
    await send('POST', '/bundles', { budget_id: budgetId, group_id: g1, name: 'M', category_ids: [a, b] });
    expect((await send('DELETE', `/categories/${a}?budget_id=${budgetId}`)).status).toBe(204);
    expect(await bundles()).toHaveLength(1);
    expect((await send('DELETE', `/categories/${b}?budget_id=${budgetId}`)).status).toBe(204);
    expect(await bundles()).toHaveLength(0);
  });
});
