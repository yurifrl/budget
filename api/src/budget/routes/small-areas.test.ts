/**
 * Characterisation tests for the small budget areas whose SQL moved into
 * budget/store (groups, assignments, category targets, category notes, month
 * notes, plan auto-assign): HTTP status + body and the resulting rows, pinned
 * before the move and unchanged after it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts } from '@shared/contracts/budget';
import { inputLocations, type OperationContract } from '@shared/operation-contract';
import { pool } from '../../core/db';
import { dbReady } from '../../core/test-gate';
import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';
import budget from '..';

const user: IdentityUser = {
  id: crypto.randomUUID(),
  email: 'small-areas@smallareas.test',
  googleSub: null,
  role: 'user',
  status: 'active',
};
const B = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const otherCat = crypto.randomUUID();
const otherGroup = crypto.randomUUID();

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);

const byName = new Map<string, OperationContract>(contracts.map((c) => [c.name, c]));

/** Calls an operation by contract name, placing each input where the contract says. */
async function op(name: string, input: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const c = byName.get(name)!;
  const loc = inputLocations(c);
  let path = c.path;
  for (const p of loc.path) path = path.replace(`:${p}`, encodeURIComponent(String(input[p])));
  const qs = new URLSearchParams();
  for (const q of loc.query) if (input[q] !== undefined && input[q] !== null) qs.set(q, String(input[q]));
  const body = c.bodyKey
    ? input[c.bodyKey]
    : loc.body.length > 0
      ? Object.fromEntries(loc.body.filter((k) => k in input).map((k) => [k, input[k]]))
      : undefined;
  const res = await app.request(`http://test${path}${qs.size ? `?${qs}` : ''}`, {
    method: c.method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined || c.method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE id = ANY($1)', [[B, OTHER]]);
  await pool.query(`DELETE FROM public.users WHERE email LIKE '%@smallareas.test'`);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, 'user')`, [user.id, user.email]);
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'small-areas', $2), ($3, 'small-other', $2)`, [
    B, user.id, OTHER,
  ]);
  await pool.query(`INSERT INTO budget_members (budget_id, user_id) VALUES ($1, $2), ($3, $2)`, [B, user.id, OTHER]);
  await pool.query(`INSERT INTO category_groups (id, budget_id, name, sort_order) VALUES ($1, $2, 'Other G', 0)`, [otherGroup, OTHER]);
  await pool.query(`INSERT INTO categories (id, budget_id, group_id, name, sort_order) VALUES ($1, $2, $3, 'Other C', 0)`, [
    otherCat, OTHER, otherGroup,
  ]);
});
afterAll(async () => {
  if (dbReady) await cleanup();
});

describe.skipIf(!dbReady)('small budget areas (characterisation)', () => {
  let g1 = '';
  let g2 = '';
  let c1 = '';
  let c2 = '';

  test('groups: create sorts after the last group, list orders by sort_order', async () => {
    const a = await op('budget_groups_create', { budget_id: B, name: 'First' });
    const b = await op('budget_groups_create', { budget_id: B, name: 'Second' });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ budget_id: B, name: 'First', sort_order: 0, deleted: false });
    expect(b.json).toMatchObject({ name: 'Second', sort_order: 1 });
    g1 = a.json.id;
    g2 = b.json.id;
    const list = await op('budget_groups_list', { budget_id: B });
    expect(list.json.map((g: any) => g.name)).toEqual(['First', 'Second']);
  });

  test('groups: rename 200 / 404 for unknown and for other budget', async () => {
    expect((await op('budget_groups_rename', { id: g1, budget_id: B, name: 'Renamed' })).status).toBe(204);
    const miss = await op('budget_groups_rename', { id: crypto.randomUUID(), budget_id: B, name: 'x' });
    expect(miss.status).toBe(404);
    expect(miss.json).toEqual({ error: 'category group not found', code: 'not_found' });
    expect((await op('budget_groups_rename', { id: otherGroup, budget_id: B, name: 'x' })).status).toBe(404);
    const row = await pool.query('SELECT name FROM category_groups WHERE id = $1', [g1]);
    expect(row.rows[0].name).toBe('Renamed');
  });

  test('categories under groups for the later tests', async () => {
    const r1 = await pool.query(
      `INSERT INTO categories (budget_id, group_id, name, sort_order) VALUES ($1, $2, 'C1', 0), ($1, $3, 'C2', 0) RETURNING id, name`,
      [B, g1, g2],
    );
    c1 = r1.rows.find((r) => r.name === 'C1').id;
    c2 = r1.rows.find((r) => r.name === 'C2').id;
    expect(c1 && c2).toBeTruthy();
  });

  test('assignments: set upserts, list returns rows, batch applies all', async () => {
    const set = await op('budget_assignments_set', { budget_id: B, month: '2026-01-01', category_id: c1, budgeted: 12340 });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ category_id: c1, budgeted: 12340 });
    expect(String(set.json.month)).toContain('2026-01-01');
    const again = await op('budget_assignments_set', { budget_id: B, month: '2026-01-01', category_id: c1, budgeted: 500 });
    expect(again.json.budgeted).toBe(500);
    const batch = await op('budget_assignments_batch', {
      budget_id: B,
      month: '2026-02-01',
      updates: [{ category_id: c1, budgeted: 100 }, { category_id: c2, budgeted: 200 }],
    });
    expect(batch.status).toBe(204);
    const list = await op('budget_assignments_list', { budget_id: B });
    const got = list.json.map((r: any) => [r.category_id === c1 ? 'c1' : 'c2', Number(r.budgeted)]).sort();
    expect(got).toEqual([['c1', 100], ['c1', 500], ['c2', 200]]);
  });

  test('plan auto-assign: stores cents x 10, 400 for an unknown category and rolls back', async () => {
    const ok = await op('budget_plan_auto_assign', { budget_id: B, month: '2026-03-01', rows: [{ category_id: c1, assigned: 12340 }] });
    expect(ok.status).toBe(204);
    const r = await pool.query(`SELECT budgeted FROM assignments WHERE budget_id = $1 AND month = '2026-03-01'`, [B]);
    expect(r.rows.map((x) => Number(x.budgeted))).toEqual([12340]);
    const bad = await op('budget_plan_auto_assign', {
      budget_id: B,
      month: '2026-04-01',
      rows: [{ category_id: c2, assigned: 50 }, { category_id: otherCat, assigned: 50 }],
    });
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: 'category not found in budget', code: 'category_not_in_budget' });
    const none = await pool.query(`SELECT 1 FROM assignments WHERE budget_id = $1 AND month = '2026-04-01'`, [B]);
    expect(none.rowCount).toBe(0);
  });

  test('category targets: set upserts, list, delete, 404s', async () => {
    const set = await op('budget_category_targets_set', { categoryId: c1, budget_id: B, kind: 'monthly', amount: 7000, snooze_month: null });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ budget_id: B, category_id: c1, kind: 'monthly', amount: 7000 });
    const up = await op('budget_category_targets_set', { categoryId: c1, budget_id: B, kind: 'monthly', amount: 9000, snooze_month: null });
    expect(up.json.amount).toBe(9000);
    expect((await op('budget_category_targets_set', { categoryId: otherCat, budget_id: B, kind: 'monthly', amount: 10, snooze_month: null })).status).toBe(404);
    const list = await op('budget_category_targets_list', { budget_id: B });
    expect(list.json.map((t: any) => t.category_id)).toEqual([c1]);
    expect((await op('budget_category_targets_delete', { categoryId: c1, budget_id: B })).status).toBe(204);
    const miss = await op('budget_category_targets_delete', { categoryId: c1, budget_id: B });
    expect(miss.status).toBe(404);
    expect(miss.json).toEqual({ error: 'target not found', code: 'not_found' });
  });

  test('category notes: set upserts per month, list by month, 404 for foreign category', async () => {
    const set = await op('budget_category_notes_set', { categoryId: c1, budget_id: B, month: '2026-01-01', note: 'hello' });
    expect(set.json).toEqual({ category_id: c1, note: 'hello' });
    expect((await op('budget_category_notes_set', { categoryId: c1, budget_id: B, month: '2026-01-01', note: '' })).json.note).toBe('');
    expect((await op('budget_category_notes_set', { categoryId: c2, budget_id: B, month: '2026-02-01', note: 'feb' })).status).toBe(200);
    const list = await op('budget_category_notes_list', { budget_id: B, month: '2026-01-01' });
    expect(list.json).toEqual([{ category_id: c1, note: '' }]);
    expect((await op('budget_category_notes_set', { categoryId: otherCat, budget_id: B, month: '2026-01-01', note: 'x' })).status).toBe(404);
  });

  test('month notes: set upserts, list excludes tombstones', async () => {
    const set = await op('budget_month_notes_set', { budget_id: B, month: '2026-01-01', note: 'jan' });
    expect(set.status).toBe(200);
    expect(set.json.note).toBe('jan');
    await op('budget_month_notes_set', { budget_id: B, month: '2026-01-01', note: 'jan2' });
    await op('budget_month_notes_set', { budget_id: B, month: '2026-02-01', note: 'feb' });
    await pool.query(`UPDATE month_notes SET deleted = true WHERE budget_id = $1 AND month = '2026-02-01'`, [B]);
    const list = await op('budget_month_notes_list', { budget_id: B });
    expect(list.json.map((n: any) => n.note)).toEqual(['jan2']);
  });

  test('groups: delete tombstones the group and its live categories; second delete 404', async () => {
    const del = await op('budget_groups_delete', { id: g1, budget_id: B });
    expect(del.status).toBe(204);
    const cat = await pool.query('SELECT id, deleted FROM categories WHERE budget_id = $1 ORDER BY name', [B]);
    expect(cat.rows.map((r) => r.deleted)).toEqual([true, false]);
    expect((await op('budget_groups_delete', { id: g1, budget_id: B })).status).toBe(404);
    const list = await op('budget_groups_list', { budget_id: B });
    expect(list.json.map((g: any) => g.name)).toEqual(['Second']);
  });
});
