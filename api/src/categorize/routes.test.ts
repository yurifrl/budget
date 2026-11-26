/**
 * HTTP tests of the Categorize page: the queue's states/bundles/threshold,
 * accept/undo/skip and the settings. Every handler's result
 * is validated against its contract output by the test preload.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { pool } from '../core/db';
import { configureSecretBox } from '../core/secret-box';
import { dbReady } from '../core/test-gate';
import { httpOnError } from '../core/validate';
import { JEV_MAX_OPTIONS, saveOwnKey } from '../jev';
import type { IdentityUser } from '../user';
import router from './router';
import { replaceSuggestions } from './store';
import { cleanupFixtures, newAccount, newBudget, newCategory, newGroup, newTransaction, newUser, type BudgetFixture } from './testing';

let acting: IdentityUser;
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', acting);
  return next();
});
app.route('/categorize', router);

const user = (id: string, email: string): IdentityUser => ({ id, email, googleSub: null, role: 'user', status: 'active' });
const ownerUser = () => user(a.userId, 'owner@categorize.test');
const memberUser = () => user(memberId, 'member@categorize.test');
const strangerUser = () => user(strangerId, 'stranger@categorize.test');

let a: BudgetFixture;
let memberId: string;
let strangerId: string;
let other: BudgetFixture;
const budgetIds: string[] = [];

async function call(who: IdentityUser, method: string, path: string, body?: unknown) {
  acting = who;
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const queue = (who: IdentityUser, extra = '') =>
  call(who, 'GET', `/categorize/queue?budget_id=${a.budgetId}&limit=50${extra}`);
const accept = (who: IdentityUser, items: unknown[], budgetId = a.budgetId) =>
  call(who, 'POST', '/categorize/accept', { budget_id: budgetId, items });
const acceptBundle = (who: IdentityUser, bundleKey: string, expectedCount: number, budgetId = a.budgetId) =>
  call(who, 'POST', '/categorize/accept', { budget_id: budgetId, bundle_key: bundleKey, expected_count: expectedCount });
const undo = (who: IdentityUser, transactionIds: string[], budgetId = a.budgetId) =>
  call(who, 'POST', '/categorize/undo', { budget_id: budgetId, transaction_ids: transactionIds });
const skip = (who: IdentityUser, transactionId: string, budgetId = a.budgetId) =>
  call(who, 'POST', '/categorize/skip', { budget_id: budgetId, transaction_id: transactionId });

async function suggest(
  transactionId: string,
  categoryId: string,
  opts: { rank?: number; confidence?: number; source?: string; status?: string; reason?: string | null } = {},
) {
  await pool.query(
    `insert into public.category_suggestions
       (transaction_id, budget_id, rank, category_id, confidence, reason, source, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (transaction_id, rank) do update
       set category_id = excluded.category_id, confidence = excluded.confidence,
           reason = excluded.reason, source = excluded.source, status = excluded.status`,
    [transactionId, a.budgetId, opts.rank ?? 1, categoryId, opts.confidence ?? 0.9, opts.reason ?? 'why', opts.source ?? 'jev', opts.status ?? 'pending'],
  );
}

async function attempt(transactionId: string, outcome: 'no_suggestion' | 'failed' | 'suggested', kind: string | null = null) {
  await pool.query(
    `insert into public.categorize_attempts (transaction_id, budget_id, outcome, error_kind, attempts, input_fingerprint)
     values ($1, $2, $3, $4, 1, 'fp')`,
    [transactionId, a.budgetId, outcome, kind],
  );
}

async function queueJson(who: IdentityUser, extra = '') {
  const res = await queue(who, extra);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ rows: any[]; counts: any; bundles: any[] }>;
}

async function txn(over: Parameters<typeof newTransaction>[0] extends infer T ? Partial<T> : never = {}) {
  return newTransaction({ budgetId: a.budgetId, accountId: a.accountId, date: '2026-11-20', amount: -2500, ...over });
}

beforeEach(async () => {
  if (!dbReady) return;
  await cleanupFixtures();
  a = await newBudget('page');
  memberId = await newUser('page-member');
  strangerId = await newUser('page-stranger');
  await pool.query('insert into public.budget_members (budget_id, user_id) values ($1, $2)', [a.budgetId, memberId]);
  other = await newBudget('page-other');
  budgetIds.push(a.budgetId, other.budgetId);
});

afterAll(async () => {
  if (!dbReady) return;
  await cleanupFixtures();
});

describe.skipIf(!dbReady)('queue', () => {
  test('distinguishes every state, newest first', async () => {
    const has = await txn({ payeeId: await newPayee('Bakery') });
    const below = await txn({ payeeId: await newPayee('Below') });
    const none = await txn({ payeeId: await newPayee('Nothing') });
    const failed = await txn({ payeeId: await newPayee('Broken') });
    const fresh = await txn({ payeeId: await newPayee('Fresh') });
    const dismissed = await txn({ payeeId: await newPayee('Skipped') });
    const categorized = await txn({ categoryId: a.food, payeeId: await newPayee('Done') });

    await suggest(has, a.food, { rank: 1, confidence: 0.94 });
    await suggest(has, a.dining, { rank: 2, confidence: 0.6 });
    await suggest(below, a.food, { confidence: 0.5 });
    await attempt(none, 'no_suggestion');
    await attempt(failed, 'failed', 'timeout');
    await suggest(dismissed, a.food, { status: 'dismissed' });
    await suggest(categorized, a.food, { confidence: 0.99 });

    const page = await queueJson(memberUser());
    const byId = new Map(page.rows.map((row) => [row.transaction_id, row]));
    expect(byId.size).toBe(5); // decided rows (dismissed/categorized) are out
    expect(byId.get(has)).toMatchObject({ state: 'has_suggestions' });
    expect(byId.get(has).suggestions).toEqual([
      { category_id: a.food, category_name: 'Food', confidence: 0.94, reason: 'why', source: 'jev' },
    ]);
    expect(byId.get(below)).toMatchObject({ state: 'below_threshold', suggestions: [] });
    expect(byId.get(none)).toMatchObject({ state: 'no_suggestion' });
    expect(byId.get(failed)).toMatchObject({ state: 'failed' });
    expect(byId.get(fresh)).toMatchObject({ state: 'not_classified' });
    expect(page.counts).toEqual({
      left_to_categorize: 5,
      above_threshold: 1,
      has_suggestions: 1,
      below_threshold: 1,
      no_suggestion: 1,
      failed: 1,
      not_classified: 1,
    });
    expect(page.bundles.map((b) => b.payee)).toEqual(['Bakery']);
  });

  test('the threshold is applied at read time', async () => {
    const t = await txn({ payeeId: await newPayee('Threshold') });
    await suggest(t, a.food, { confidence: 0.6 });
    expect((await queueJson(ownerUser())).rows[0].state).toBe('below_threshold');

    const set = await call(ownerUser(), 'PUT', '/categorize/settings', { budget_id: a.budgetId, confidence_threshold: 0.5 });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ budget_id: a.budgetId, confidence_threshold: 0.5 });
    const page = await queueJson(ownerUser());
    expect(page.rows[0]).toMatchObject({ state: 'has_suggestions' });
    expect(page.rows[0].suggestions[0].category_id).toBe(a.food);
    expect((await (await call(ownerUser(), 'GET', `/categorize/settings?budget_id=${a.budgetId}`)).json()).confidence_threshold).toBe(0.5);
  });

  test('bundles cover the whole queue, not the page, and split on the top suggestion', async () => {
    const payee = await newPayee('Bundle Cafe');
    const ids: string[] = [];
    for (let day = 1; day <= 3; day++) {
      const id = await txn({ payeeId: payee, date: `2026-11-0${day}`, amount: -1000 * day });
      await suggest(id, a.food, { confidence: 0.9 });
      ids.push(id);
    }
    const split = await txn({ payeeId: payee, date: '2026-11-04' });
    await suggest(split, a.dining, { confidence: 0.85 });

    const res = await call(ownerUser(), 'GET', `/categorize/queue?budget_id=${a.budgetId}&limit=1`);
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(page.rows.length).toBe(1);
    expect(page.bundles.length).toBe(2);
    const bundle = page.bundles.find((b: any) => b.suggestion.category_id === a.food);
    expect(bundle).toMatchObject({ count: 3, total: -6000, first_date: '2026-11-01', last_date: '2026-11-03' });
    expect(bundle.transaction_ids).toBeUndefined();
    expect(typeof bundle.bundle_key).toBe('string');

    const bundleFilter = `bundle=${encodeURIComponent(bundle.bundle_key)}`;
    const filtered = await (await call(ownerUser(), 'GET', `/categorize/queue?budget_id=${a.budgetId}&limit=2&offset=0&${bundleFilter}`)).json();
    expect(filtered.rows.map((row: any) => row.transaction_id)).toEqual([ids[2], ids[1]]);
    const next = await (await call(ownerUser(), 'GET', `/categorize/queue?budget_id=${a.budgetId}&limit=2&offset=2&${bundleFilter}`)).json();
    expect(next.rows.map((row: any) => row.transaction_id)).toEqual([ids[0]]);
    expect(filtered.counts.left_to_categorize).toBe(4);

    const accepted = await acceptBundle(ownerUser(), bundle.bundle_key, 3);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).accepted).toBe(3);
    expect((await pool.query('select category_id from public.transactions where id = any($1)', [ids])).rows.map((r) => r.category_id))
      .toEqual([a.food, a.food, a.food]);
  });

  test('a pending suggestion on a hidden category is no_suggestion, not below_threshold', async () => {
    const hiddenOnly = await txn({ payeeId: await newPayee('Hidden only') });
    const low = await txn({ payeeId: await newPayee('Low only') });
    const hiddenAtHigh = await txn({ payeeId: await newPayee('Hidden high') });
    await suggest(hiddenOnly, a.hidden, { confidence: 0.99 });
    await suggest(low, a.food, { confidence: 0.5 });
    await suggest(hiddenAtHigh, a.hidden, { confidence: 0.99 });
    await attempt(hiddenAtHigh, 'suggested');

    const page = await queueJson(ownerUser());
    const byId = new Map(page.rows.map((row) => [row.transaction_id, row]));
    expect(byId.get(hiddenOnly)).toMatchObject({ state: 'no_suggestion', suggestions: [] });
    expect(byId.get(hiddenAtHigh)).toMatchObject({ state: 'no_suggestion', suggestions: [] });
    expect(byId.get(low)).toMatchObject({ state: 'below_threshold', suggestions: [] });
    expect(page.counts).toMatchObject({
      left_to_categorize: 3,
      above_threshold: 0,
      has_suggestions: 0,
      below_threshold: 1,
      no_suggestion: 2,
      failed: 0,
      not_classified: 0,
    });
  });

  test('a bundle above 1000 rows is refused without applying anything', async () => {
    const payee = await newPayee('Huge bundle');
    await pool.query(
      `insert into public.transactions (id, budget_id, account_id, date, amount, payee_id)
       select gen_random_uuid(), $1, $2, '2026-11-01', -100, $3 from generate_series(1, 1001)`,
      [a.budgetId, a.accountId, payee],
    );
    await pool.query(
      `insert into public.category_suggestions (transaction_id, budget_id, rank, category_id, confidence, source)
       select id, $2, 1, $3, 0.9, 'jev' from public.transactions where payee_id = $1 and budget_id = $2`,
      [payee, a.budgetId, a.food],
    );
    const page = await queueJson(ownerUser());
    expect(page.bundles).toHaveLength(1);
    expect(page.bundles[0]).toMatchObject({ count: 1001 });
    const res = await acceptBundle(ownerUser(), page.bundles[0].bundle_key, 1001);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('categorize_bundle_too_large');
    expect((await pool.query('select count(*)::int as n from public.transactions where payee_id = $1 and category_id is not null', [payee])).rows[0].n).toBe(0);
  });

  test('a bundle key that no longer resolves is 409, an invalid key is 400', async () => {
    const t = await txn({ payeeId: await newPayee('Gone bundle') });
    await suggest(t, a.food);
    const page = await queueJson(ownerUser());
    const key = page.bundles[0].bundle_key;
    await pool.query(`delete from public.category_suggestions where transaction_id = $1`, [t]);
    const gone = await acceptBundle(ownerUser(), key, 1);
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: 'categorize_bundle_changed', params: { expected: 1, actual: 0 } });
    const bad = await call(ownerUser(), 'POST', '/categorize/accept', { budget_id: a.budgetId, bundle_key: 'not-a-key' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_input');
  });

  test('bundle totals are bigint-safe above int4', async () => {
    const payee = await newPayee('Large bundle');
    const first = await txn({ payeeId: payee, date: '2026-11-01', amount: -2_000_000_000 });
    const second = await txn({ payeeId: payee, date: '2026-11-02', amount: -2_000_000_000 });
    await suggest(first, a.food);
    await suggest(second, a.food);
    const page = await queueJson(ownerUser());
    expect(page.bundles).toHaveLength(1);
    expect(page.bundles[0]).toMatchObject({ count: 2, total: -4_000_000_000 });
    const accepted = await acceptBundle(ownerUser(), page.bundles[0].bundle_key, 2);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).accepted).toBe(2);
  });

  test('a bundle key round-trips a long non-ASCII unlinked payee name', async () => {
    const name = `Loja ${'ação 🚀 '.repeat(120)}`;
    const t = await txn({ importPayeeName: name });
    await suggest(t, a.food);
    const page = await queueJson(ownerUser());
    expect(page.bundles).toHaveLength(1);
    expect(page.bundles[0]).toMatchObject({ payee: name, count: 1 });
    expect(page.bundles[0].bundle_key.length).toBeLessThan(300);

    const filtered = await (await call(
      ownerUser(),
      'GET',
      `/categorize/queue?budget_id=${a.budgetId}&bundle=${encodeURIComponent(page.bundles[0].bundle_key)}`,
    )).json();
    expect(filtered.rows.map((row: any) => row.transaction_id)).toEqual([t]);

    const accepted = await acceptBundle(ownerUser(), page.bundles[0].bundle_key, 1);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).accepted).toBe(1);
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBe(a.food);
  });

  test('accept by bundle refuses a stale expected_count and applies nothing', async () => {
    const payee = await newPayee('Grew bundle');
    const first = await txn({ payeeId: payee });
    await suggest(first, a.food);
    const page = await queueJson(ownerUser());
    const bundle = page.bundles[0];
    expect(bundle).toMatchObject({ count: 1 });

    const late = await txn({ payeeId: payee });
    await suggest(late, a.food);
    const stale = await acceptBundle(ownerUser(), bundle.bundle_key, bundle.count);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: 'categorize_bundle_changed',
      params: { expected: 1, actual: 2 },
    });
    const rows = (await pool.query('select category_id from public.transactions where id = any($1)', [[first, late]])).rows;
    expect(rows.every((row) => row.category_id === null)).toBe(true);

    // A bundle always carries the page's count; items do not take one.
    const missing = await call(ownerUser(), 'POST', '/categorize/accept', { budget_id: a.budgetId, bundle_key: bundle.bundle_key });
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe('invalid_input');
    const onItems = await call(ownerUser(), 'POST', '/categorize/accept', {
      budget_id: a.budgetId,
      items: [{ transaction_id: first, category_id: a.food }],
      expected_count: 1,
    });
    expect(onItems.status).toBe(400);
    expect((await onItems.json()).code).toBe('invalid_input');
  });

  test('returns the owner\'s own text and bank facts unmasked and untruncated', async () => {
    const long = `PIX ENVIADO JOAO DA SILVA CPF 123.456.789-09 ${'X'.repeat(300)}`;
    const id = await txn({
      payeeId: await newPayee('Merchant Shopper'),
      rawPayload: {
        descriptionRaw: long,
        operationType: 'PIX',
        merchant: { name: 'Padaria Central', businessName: 'Padaria Central LTDA', cnpj: '12.345.678/0001-90', category: 'Food' },
        paymentData: { receiver: { name: 'Mariana Souza' } },
      },
    });
    await suggest(id, a.food);
    const row = (await queueJson(ownerUser())).rows.find((r) => r.transaction_id === id);
    expect(row.raw_bank_description).toBe(long);
    expect(row.merchant).toEqual({
      name: 'Padaria Central',
      legal_name: 'Padaria Central LTDA',
      cnpj: '12.345.678/0001-90',
      business_category: 'Food',
      operation_type: 'PIX',
      counterparty_name: 'Mariana Souza',
    });
  });
});

async function newPayee(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('insert into public.payees (id, budget_id, name) values ($1, $2, $3)', [id, a.budgetId, name]);
  return id;
}

describe.skipIf(!dbReady)('accept, undo and skip', () => {
  test('accepts a batch through the transaction path, marks the choice and is idempotent', async () => {
    const t1 = await txn({ payeeId: await newPayee('One') });
    const t2 = await txn({ payeeId: await newPayee('Two') });
    await suggest(t1, a.food, { rank: 1 });
    await suggest(t1, a.dining, { rank: 2 });

    const revBefore = (await pool.query('select revision from public.budgets where id = $1', [a.budgetId])).rows[0].revision;
    const res = await accept(memberUser(), [
      { transaction_id: t1, category_id: a.food },
      { transaction_id: t2, category_id: a.dining },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ accepted: 2, items: [{ transaction_id: t1, category_id: a.food }, { transaction_id: t2, category_id: a.dining }] });

    const rows = (await pool.query('select id, category_id from public.transactions where id = any($1) order by id', [[t1, t2]])).rows;
    expect(rows.map((r) => r.category_id).sort()).toEqual([a.food, a.dining].sort());
    const suggestions = (await pool.query('select rank, status, source from public.category_suggestions where transaction_id = $1 order by rank', [t1])).rows;
    expect(suggestions).toEqual([{ rank: 1, status: 'accepted', source: 'jev' }, { rank: 2, status: 'dismissed', source: 'jev' }]);
    const revAfter = (await pool.query('select revision from public.budgets where id = $1', [a.budgetId])).rows[0].revision;
    expect(revAfter).toBeGreaterThan(revBefore);

    // Repeat: same pairs are a no-op (the decision record exists) and do not
    // bump the revision; t2's manual choice from the first accept stays.
    const repeat = await accept(memberUser(), [{ transaction_id: t1, category_id: a.food }, { transaction_id: t2, category_id: a.dining }]);
    expect(repeat.status).toBe(200);
    expect((await (await accept(memberUser(), [{ transaction_id: t2, category_id: a.dining }])).json()).accepted).toBe(0);
    expect((await pool.query('select revision from public.budgets where id = $1', [a.budgetId])).rows[0].revision).toBe(revAfter);
    const manual = (await pool.query('select source, status from public.category_suggestions where transaction_id = $1', [t2])).rows;
    expect(manual).toEqual([{ source: 'manual', status: 'accepted' }]);
    // The queue no longer shows either.
    expect((await queueJson(ownerUser())).rows).toEqual([]);
  });

  test('two concurrent accepts for one transaction: exactly one wins, the other sees it no longer needs a category', async () => {
    const t = await txn({ payeeId: await newPayee('Race') });
    await suggest(t, a.food, { rank: 1 });
    await suggest(t, a.dining, { rank: 2 });
    const [one, two] = await Promise.all([
      accept(ownerUser(), [{ transaction_id: t, category_id: a.food }]),
      accept(ownerUser(), [{ transaction_id: t, category_id: a.dining }]),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const loser = one.status === 409 ? one : two;
    expect((await loser.json()).code).toBe('categorize_already_categorized');
    const winnerCategory = (await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id;
    expect([a.food, a.dining]).toContain(winnerCategory);
    const rows = (await pool.query('select category_id, status from public.category_suggestions where transaction_id = $1 order by rank', [t])).rows;
    expect(rows.filter((r) => r.status === 'accepted')).toEqual([{ category_id: winnerCategory, status: 'accepted' }]);
  });

  test('rejects a foreign category and a foreign transaction without applying anything', async () => {
    const t = await txn({ payeeId: await newPayee('Guard') });
    const foreignCategory = await newCategory(other.budgetId, (await newGroup(other.budgetId, 'G')), 'Foreign');

    const byCategory = await accept(ownerUser(), [{ transaction_id: t, category_id: foreignCategory }]);
    expect(byCategory.status).toBe(400);
    expect((await byCategory.json()).code).toBe('category_not_in_budget');
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBeNull();

    const otherTxn = await newTransaction({ budgetId: other.budgetId, accountId: other.accountId, date: '2026-11-01', amount: -100 });
    const byTxn = await accept(ownerUser(), [{ transaction_id: otherTxn, category_id: a.food }]);
    expect(byTxn.status).toBe(404);
    expect((await pool.query('select category_id from public.transactions where id = $1', [otherTxn])).rows[0].category_id).toBeNull();

    // Partial failure: the first item is valid, the second is foreign; none is applied.
    const good = await txn({ payeeId: await newPayee('Good') });
    const partial = await accept(ownerUser(), [{ transaction_id: good, category_id: a.food }, { transaction_id: otherTxn, category_id: a.food }]);
    expect(partial.status).toBe(404);
    expect((await pool.query('select category_id from public.transactions where id = $1', [good])).rows[0].category_id).toBeNull();
  });

  test('rejects a category that is not assignable, an already categorized row and one that no longer needs a category', async () => {
    const hidden = await txn({ payeeId: await newPayee('Hidden Cat') });
    const hiddenRes = await accept(ownerUser(), [{ transaction_id: hidden, category_id: a.hidden }]);
    expect(hiddenRes.status).toBe(400);
    expect((await hiddenRes.json()).code).toBe('category_not_assignable');

    const done = await txn({ categoryId: a.food, payeeId: await newPayee('Already') });
    const doneRes = await accept(ownerUser(), [{ transaction_id: done, category_id: a.dining }]);
    expect(doneRes.status).toBe(409);
    expect((await doneRes.json()).code).toBe('categorize_already_categorized');

    const inflow = await txn({ amount: 50_000, payeeId: await newPayee('Salary') });
    const inflowRes = await accept(ownerUser(), [{ transaction_id: inflow, category_id: a.food }]);
    expect(inflowRes.status).toBe(409);
    expect((await inflowRes.json()).code).toBe('categorize_not_needing_category');
  });

  test('undo clears the category and restores suggestions; a changed category is stale', async () => {
    const t = await txn({ payeeId: await newPayee('Undo') });
    await suggest(t, a.food, { rank: 1 });
    await suggest(t, a.dining, { rank: 2 });
    const accepted = await (await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }])).json();

    const back = await undo(ownerUser(), [t]);
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ restored: 1, transaction_ids: [t], skipped: [] });
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBeNull();
    expect((await pool.query('select rank, status from public.category_suggestions where transaction_id = $1 order by rank', [t])).rows)
      .toEqual([{ rank: 1, status: 'pending' }, { rank: 2, status: 'pending' }]);
    // The decision was consumed: a second undo has nothing to reverse.
    expect(await (await undo(ownerUser(), [t])).json())
      .toEqual({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'no_decision' }] });

    // Accept again, then change the category behind the page's back: undo
    // leaves it alone and reports it skipped.
    await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }]);
    await pool.query('update public.transactions set category_id = $2 where id = $1', [t, a.dining]);
    const stale = await undo(ownerUser(), [t]);
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'category_changed' }] });
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBe(a.dining);
    expect((await pool.query('select status from public.category_suggestions where transaction_id = $1 order by rank', [t])).rows.map((r) => r.status))
      .toEqual(['accepted', 'dismissed']);
  });

  test('undo applies eligible items and skips a changed one in the same batch', async () => {
    const changed = await txn({ payeeId: await newPayee('Changed') });
    const eligible = await txn({ payeeId: await newPayee('Eligible') });
    await accept(ownerUser(), [
      { transaction_id: changed, category_id: a.food },
      { transaction_id: eligible, category_id: a.dining },
    ]);
    await pool.query('update public.transactions set category_id = $2 where id = $1', [changed, a.dining]);
    const res = await undo(ownerUser(), [changed, eligible]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: 1, transaction_ids: [eligible], skipped: [{ transaction_id: changed, reason: 'category_changed' }] });
    const after = (await pool.query('select id, category_id from public.transactions where id = any($1)', [[changed, eligible]])).rows;
    expect(Object.fromEntries(after.map((r) => [r.id, r.category_id]))).toEqual({ [changed]: a.dining, [eligible]: null });
  });

  test('accept refuses a skipped transaction (the decision freezes it)', async () => {
    const t = await txn({ payeeId: await newPayee('Frozen') });
    await suggest(t, a.food);
    await skip(ownerUser(), t);
    const res = await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }]);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('categorize_already_categorized');
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBeNull();
  });


  test('repeat accept keeps the suggestion and undo restores it to pending (no manual overwrite)', async () => {
    const t = await txn({ payeeId: await newPayee('Repeat model') });
    await suggest(t, a.food, { rank: 1, source: 'jev' });
    expect((await (await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }])).json()).accepted).toBe(1);
    const repeat = await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }]);
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).accepted).toBe(0);
    expect((await pool.query('select rank, status, source from public.category_suggestions where transaction_id = $1', [t])).rows)
      .toEqual([{ rank: 1, status: 'accepted', source: 'jev' }]);
    const back = await undo(ownerUser(), [t]);
    expect(await back.json()).toEqual({ restored: 1, transaction_ids: [t], skipped: [] });
    expect((await pool.query('select rank, status, source from public.category_suggestions where transaction_id = $1', [t])).rows)
      .toEqual([{ rank: 1, status: 'pending', source: 'jev' }]);
  });

  test('an accepted row whose category was cleared by hand is back in the queue, counted and accepted again', async () => {
    const payee = await newPayee('Cleared');
    const t = await txn({ payeeId: payee });
    await suggest(t, a.food, { rank: 1, confidence: 0.9 });
    await suggest(t, a.dining, { rank: 2, confidence: 0.85 });
    expect((await (await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }])).json()).accepted).toBe(1);

    // The register clears the category by hand; nothing on the shared
    // transactions table touches the decision, so it went stale.
    await pool.query('update public.transactions set category_id = null where id = $1', [t]);

    const page = await queueJson(ownerUser());
    expect(page.rows.map((row) => row.transaction_id)).toEqual([t]);
    expect(page.rows[0]).toMatchObject({ state: 'has_suggestions' });
    expect(page.rows[0].suggestions.map((s: { category_id: string }) => s.category_id)).toEqual([a.food, a.dining]);
    expect(page.counts).toMatchObject({ left_to_categorize: 1, above_threshold: 1, has_suggestions: 1 });
    expect(page.bundles).toHaveLength(1);
    expect(page.bundles[0]).toMatchObject({ payee: 'Cleared', count: 1, suggestion: { category_id: a.food } });

    // Undo is unchanged: a category cleared by hand is not accept's to revert,
    // and it must leave the stale record alone.
    expect(await (await undo(ownerUser(), [t])).json())
      .toEqual({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'category_changed' }] });
    expect((await pool.query('select count(*)::int as n from public.categorize_decisions where transaction_id = $1', [t])).rows[0].n).toBe(1);

    // The bundle still resolves the revived row; accepting it replaces the
    // stale record (the user changes) instead of no-op'ing or refusing.
    expect((await (await acceptBundle(memberUser(), page.bundles[0].bundle_key, 1)).json()).accepted).toBe(1);
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBe(a.food);
    expect((await pool.query('select kind, category_id, user_id from public.categorize_decisions where transaction_id = $1', [t])).rows)
      .toEqual([{ kind: 'accept', category_id: a.food, user_id: memberId }]);
    expect((await pool.query('select status from public.category_suggestions where transaction_id = $1 order by rank', [t])).rows.map((r) => r.status))
      .toEqual(['accepted', 'dismissed']);
    expect((await queueJson(ownerUser())).rows).toEqual([]);

    // Cleared again and accepted with a DIFFERENT category: a stale accept
    // takes another pair too.
    await pool.query('update public.transactions set category_id = null where id = $1', [t]);
    expect((await (await accept(ownerUser(), [{ transaction_id: t, category_id: a.dining }])).json()).accepted).toBe(1);
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBe(a.dining);
    expect((await pool.query('select kind, category_id from public.categorize_decisions where transaction_id = $1', [t])).rows)
      .toEqual([{ kind: 'accept', category_id: a.dining }]);
  });

  test('a stale accept is a candidate again, the engine write replaces its suggestions, and skip then freezes it', async () => {
    const t = await txn({ payeeId: await newPayee('Reclassified') });
    await suggest(t, a.food, { rank: 1, confidence: 0.9 });
    await suggest(t, a.dining, { rank: 2, confidence: 0.85 });
    await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }]);
    await pool.query('update public.transactions set category_id = null where id = $1', [t]);

    // The run's write is not blocked by the accepted/dismissed rows: they are
    // restored to pending and the fresh answer replaces them.
    expect(
      await replaceSuggestions(pool, a.budgetId, t, [
        { categoryId: a.dining, confidence: 0.95, reason: 'fresh', source: 'jev', provider: null, model: null },
      ]),
    ).toBe(1);
    const page = await queueJson(ownerUser());
    expect(page.rows[0].suggestions).toEqual([
      { category_id: a.dining, category_name: 'Dining', confidence: 0.95, reason: 'fresh', source: 'jev' },
    ]);

    const skipped = await skip(ownerUser(), t);
    expect(await skipped.json()).toEqual({ dismissed: 1 });
    expect((await pool.query('select kind, category_id from public.categorize_decisions where transaction_id = $1', [t])).rows)
      .toEqual([{ kind: 'skip', category_id: null }]);
    expect((await queueJson(ownerUser())).rows).toEqual([]);
    expect(
      await replaceSuggestions(pool, a.budgetId, t, [
        { categoryId: a.food, confidence: 0.9, reason: 'late', source: 'jev', provider: null, model: null },
      ]),
    ).toBe(0);
  });

  test('an accepted row whose category was changed by hand stays out of the queue and undo reports category_changed', async () => {
    const t = await txn({ payeeId: await newPayee('Hand changed') });
    await suggest(t, a.food);
    await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }]);
    await pool.query('update public.transactions set category_id = $2 where id = $1', [t, a.dining]);

    expect((await queueJson(ownerUser())).rows).toEqual([]);
    const back = await undo(ownerUser(), [t]);
    expect(await back.json()).toEqual({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'category_changed' }] });
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBe(a.dining);
  });

  test('P1: undo does not clear a category a person set by hand', async () => {
    const t = await txn({ categoryId: a.food, payeeId: await newPayee('Hand set') });
    const res = await undo(ownerUser(), [t]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'no_decision' }] });
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBe(a.food);
    expect((await pool.query('select count(*)::int as n from public.categorize_decisions where transaction_id = $1', [t])).rows[0].n).toBe(0);
  });

  test('P2: undo leaves an uncategorized inflow, and its account balance, alone', async () => {
    const t = await txn({ amount: 50_000, payeeId: await newPayee('Inflow') });
    const before = (await pool.query('select cleared_balance, uncleared_balance from public.accounts where id = $1', [a.accountId])).rows[0];
    const res = await undo(ownerUser(), [t]);
    expect(await res.json()).toEqual({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'no_decision' }] });
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBeNull();
    expect((await pool.query('select cleared_balance, uncleared_balance from public.accounts where id = $1', [a.accountId])).rows[0]).toEqual(before);
  });

  test('P3: undo does not detach an upcoming repeat occurrence, even with a record', async () => {
    const t = await txn({ categoryId: a.food, upcoming: true, payeeId: await newPayee('Scheduled') });
    const plain = await undo(ownerUser(), [t]);
    expect(await plain.json()).toEqual({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'no_decision' }] });
    expect((await pool.query('select category_id, upcoming from public.transactions where id = $1', [t])).rows[0])
      .toEqual({ category_id: a.food, upcoming: true });

    await pool.query(
      `insert into public.categorize_decisions (transaction_id, budget_id, category_id, user_id) values ($1, $2, $3, $4)`,
      [t, a.budgetId, a.food, a.userId],
    );
    const guarded = await undo(ownerUser(), [t]);
    expect(await guarded.json()).toEqual({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'upcoming' }] });
    expect((await pool.query('select category_id, upcoming from public.transactions where id = $1', [t])).rows[0])
      .toEqual({ category_id: a.food, upcoming: true });
  });

  test('P4: undo does not reopen a skipped transaction', async () => {
    const t = await txn({ payeeId: await newPayee('Skipped undo') });
    await suggest(t, a.food);
    await skip(ownerUser(), t);
    const res = await undo(ownerUser(), [t]);
    expect(await res.json()).toEqual({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'skipped' }] });
    expect((await pool.query('select status from public.category_suggestions where transaction_id = $1', [t])).rows)
      .toEqual([{ status: 'dismissed' }]);
    expect((await queueJson(ownerUser())).rows).toEqual([]);
  });

  test('P7: accept refuses a hand-categorized row instead of recording a manual choice', async () => {
    const t = await txn({ amount: 50_000, categoryId: a.food, payeeId: await newPayee('Hand inflow') });
    const res = await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }]);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('categorize_already_categorized');
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBe(a.food);
    expect((await pool.query('select count(*)::int as n from public.category_suggestions where transaction_id = $1', [t])).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int as n from public.categorize_decisions where transaction_id = $1', [t])).rows[0].n).toBe(0);
  });

  test('skip dismisses every suggestion, removes the row from the queue and is idempotent', async () => {
    const t = await txn({ payeeId: await newPayee('Skip') });
    await suggest(t, a.food, { rank: 1 });
    await suggest(t, a.dining, { rank: 2 });
    const res = await skip(memberUser(), t);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dismissed: 2 });
    expect((await queueJson(ownerUser())).rows).toEqual([]);
    expect(await (await skip(memberUser(), t)).json()).toEqual({ dismissed: 0 });
  });

  test('skip works for any queued state, records a skip and bumps the revision once', async () => {
    const none = await txn({ payeeId: await newPayee('Skip none') });
    await attempt(none, 'no_suggestion');
    const failed = await txn({ payeeId: await newPayee('Skip failed') });
    await attempt(failed, 'failed', 'timeout');
    const fresh = await txn({ payeeId: await newPayee('Skip fresh') });
    expect((await queueJson(ownerUser())).counts.left_to_categorize).toBe(3);

    const revBefore = (await pool.query('select revision from public.budgets where id = $1', [a.budgetId])).rows[0].revision;
    for (const id of [none, failed, fresh]) {
      const res = await skip(ownerUser(), id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ dismissed: 0 });
    }
    const revAfter = (await pool.query('select revision from public.budgets where id = $1', [a.budgetId])).rows[0].revision;
    expect(revAfter).toBeGreaterThan(revBefore);
    expect((await queueJson(ownerUser())).rows).toEqual([]);
    const decisions = (await pool.query('select transaction_id, kind, category_id from public.categorize_decisions where budget_id = $1 order by transaction_id', [a.budgetId])).rows;
    expect(decisions.map((row) => row.kind)).toEqual(['skip', 'skip', 'skip']);
    expect(decisions.every((row) => row.category_id === null)).toBe(true);

    // Repeat changes nothing, so it does not bump again.
    expect(await (await skip(ownerUser(), none)).json()).toEqual({ dismissed: 0 });
    expect((await pool.query('select revision from public.budgets where id = $1', [a.budgetId])).rows[0].revision).toBe(revAfter);

    // Undo never touches a skip record.
    const undoSkip = await undo(ownerUser(), [none]);
    expect(await undoSkip.json()).toEqual({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: none, reason: 'skipped' }] });
    expect((await pool.query('select kind from public.categorize_decisions where transaction_id = $1', [none])).rows[0].kind).toBe('skip');
    expect((await queueJson(ownerUser())).rows).toEqual([]);
  });

  test('a skipped row is frozen for the engine: not a candidate and no suggestion write', async () => {
    const t = await txn({ payeeId: await newPayee('Frozen') });
    await skip(ownerUser(), t);
    expect(
      await replaceSuggestions(pool, a.budgetId, t, [
        { categoryId: a.food, confidence: 0.9, reason: 'late', source: 'jev', provider: null, model: null },
      ]),
    ).toBe(0);
    expect((await pool.query('select count(*)::int as n from public.category_suggestions where transaction_id = $1', [t])).rows[0].n).toBe(0);
  });

  test('a job suggestion write does not bump the revision; skip, accept and undo do', async () => {
    const revision = async () =>
      (await pool.query('select revision from public.budgets where id = $1', [a.budgetId])).rows[0].revision as number;

    const skipped = await txn({ payeeId: await newPayee('Revision skip') });
    const rev0 = await revision();
    await suggest(skipped, a.food);
    expect(await revision()).toBe(rev0);
    await skip(ownerUser(), skipped);
    const rev1 = await revision();
    expect(rev1).toBeGreaterThan(rev0);

    const accepted = await txn({ payeeId: await newPayee('Revision accept') });
    await accept(ownerUser(), [{ transaction_id: accepted, category_id: a.food }]);
    const rev2 = await revision();
    expect(rev2).toBeGreaterThan(rev1);

    expect((await undo(ownerUser(), [accepted])).status).toBe(200);
    expect(await revision()).toBeGreaterThan(rev2);
  });

  test('undo leaves a row that became an inflow or a transfer after accept', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const inflow = await txn({ payeeId: await newPayee('Became inflow') });
    await suggest(inflow, a.food);
    await accept(ownerUser(), [{ transaction_id: inflow, category_id: a.food }]);
    await pool.query('update public.transactions set amount = 5000 where id = $1', [inflow]);

    const transfer = await txn({ payeeId: await newPayee('Became transfer') });
    await suggest(transfer, a.food);
    await accept(ownerUser(), [{ transaction_id: transfer, category_id: a.food }]);
    await pool.query('update public.transactions set transfer_account_id = $2 where id = $1', [transfer, savings]);

    const res = await undo(ownerUser(), [inflow, transfer]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      restored: 0,
      transaction_ids: [],
      skipped: [
        { transaction_id: inflow, reason: 'category_changed' },
        { transaction_id: transfer, reason: 'category_changed' },
      ],
    });
    const rows = (await pool.query('select category_id from public.transactions where id = any($1) order by id', [[inflow, transfer]])).rows;
    expect(rows.map((row) => row.category_id)).toEqual([a.food, a.food]);
  });

  test('duplicate transaction ids in one batch are invalid input', async () => {
    const t = await txn({ payeeId: await newPayee('Dupes') });
    const dupAccept = await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }, { transaction_id: t, category_id: a.food }]);
    expect(dupAccept.status).toBe(400);
    expect((await dupAccept.json()).code).toBe('invalid_input');
    const dupUndo = await undo(ownerUser(), [t, t]);
    expect(dupUndo.status).toBe(400);
    expect((await dupUndo.json()).code).toBe('invalid_input');
  });

  test('overlapping accepts in opposite order do not deadlock (ids locked in order)', async () => {
    const t1 = await txn({ payeeId: await newPayee('Order one') });
    const t2 = await txn({ payeeId: await newPayee('Order two') });
    const [one, two] = await Promise.all([
      accept(ownerUser(), [{ transaction_id: t1, category_id: a.food }, { transaction_id: t2, category_id: a.dining }]),
      accept(ownerUser(), [{ transaction_id: t2, category_id: a.dining }, { transaction_id: t1, category_id: a.food }]),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    const rows = (await pool.query('select id, category_id from public.transactions where id = any($1)', [[t1, t2]])).rows;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.category_id]))).toEqual({ [t1]: a.food, [t2]: a.dining });
  });

  test('accept and undo with overlapping ids in opposite order do not deadlock', async () => {
    const t1 = await txn({ payeeId: await newPayee('Mixed one') });
    const t2 = await txn({ payeeId: await newPayee('Mixed two') });
    await accept(ownerUser(), [{ transaction_id: t1, category_id: a.food }, { transaction_id: t2, category_id: a.dining }]);
    const [back, again] = await Promise.all([
      undo(ownerUser(), [t2, t1]),
      accept(ownerUser(), [{ transaction_id: t2, category_id: a.dining }, { transaction_id: t1, category_id: a.food }]),
    ]);
    expect([back.status, again.status]).toEqual([200, 200]);
  });

  test('undo bumps the budget revision', async () => {
    const t = await txn({ payeeId: await newPayee('Undo revision') });
    await suggest(t, a.food);
    await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }]);
    const revBefore = (await pool.query('select revision from public.budgets where id = $1', [a.budgetId])).rows[0].revision;
    expect((await undo(ownerUser(), [t])).status).toBe(200);
    const revAfter = (await pool.query('select revision from public.budgets where id = $1', [a.budgetId])).rows[0].revision;
    expect(revAfter).toBeGreaterThan(revBefore);
  });
});

describe.skipIf(!dbReady)('access', () => {
  test('a non-member gets 404 on every operation and nothing changes', async () => {
    const t = await txn({ payeeId: await newPayee('Private') });
    await suggest(t, a.food);
    const requests: [string, string, unknown?][] = [
      ['GET', `/categorize/queue?budget_id=${a.budgetId}`],
      ['POST', '/categorize/accept', { budget_id: a.budgetId, items: [{ transaction_id: t, category_id: a.food }] }],
      ['POST', '/categorize/undo', { budget_id: a.budgetId, items: [{ transaction_id: t, category_id: a.food }] }],
      ['POST', '/categorize/skip', { budget_id: a.budgetId, transaction_id: t }],
      ['GET', `/categorize/settings?budget_id=${a.budgetId}`],
      ['PUT', '/categorize/settings', { budget_id: a.budgetId, confidence_threshold: 0.1 }],
    ];
    for (const [method, path, body] of requests) {
      const res = await call(strangerUser(), method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect((await res.text()).includes('Private')).toBe(false);
    }
    expect((await pool.query('select category_id from public.transactions where id = $1', [t])).rows[0].category_id).toBeNull();
    expect((await pool.query('select 1 from public.categorize_settings where budget_id = $1', [a.budgetId])).rowCount).toBe(0);
  });

  test('a member who is not the owner reads the page', async () => {
    const t = await txn({ payeeId: await newPayee('Member Read') });
    await suggest(t, a.food);
    const page = await queueJson(memberUser());
    expect(page.rows.length).toBe(1);

    // The member cannot see a foreign budget either.
    const foreign = await call(memberUser(), 'GET', `/categorize/queue?budget_id=${other.budgetId}`);
    expect(foreign.status).toBe(404);
  });
});

/**
 * The API's error body, read field by field: a test asserting on a refusal is
 * the boundary here, so its shape is checked rather than assumed.
 */
async function refusal(res: Response): Promise<{ error: string; code: string; reason: unknown; max: unknown }> {
  const raw: unknown = await res.json();
  if (typeof raw !== 'object' || raw === null) throw new Error('the response body is not an object');
  if (!('error' in raw) || typeof raw.error !== 'string') throw new Error('the error body has no message');
  if (!('code' in raw) || typeof raw.code !== 'string') throw new Error('the error body has no code');
  const params = 'params' in raw ? raw.params : undefined;
  const param = (key: 'reason' | 'max'): unknown => {
    if (typeof params !== 'object' || params === null) return undefined;
    if (key === 'reason') return 'reason' in params ? params.reason : undefined;
    return 'max' in params ? params.max : undefined;
  };
  return { error: raw.error, code: raw.code, reason: param('reason'), max: param('max') };
}

describe.skipIf(!dbReady)('starting a run', () => {
  const start = (who: IdentityUser, budgetId = a.budgetId) => call(who, 'POST', '/categorize/run', { budget_id: budgetId });
  const queued = async () =>
    (
      await pool.query("select 1 from jobs.job_runs where job_type = 'categorize_run' and subject_key = $1", [
        a.budgetId,
      ])
    ).rowCount;

  test('a run that cannot be answered is refused before a job exists, with its own reason', async () => {
    // No key: the sentence names why (no shared key for this account), never the
    // generic "Jev is not available", and the page can read the reason back.
    const noKey = await start(ownerUser());
    expect(noKey.status).toBe(503);
    const rejected = await refusal(noKey);
    expect(rejected.code).toBe('jev_unavailable');
    expect(rejected.reason).toBe('flag_off');
    expect(rejected.error).toContain('shared key');
    expect(await queued()).toBe(0);

    configureSecretBox({ current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) });
    try {
      await saveOwnKey(pool, a.userId, 'sk-or-v1-0123456789abcdef');

      // A key but nothing Jev may suggest from: its own code, still no job.
      await pool.query('update public.categories set hidden = true where budget_id = $1', [a.budgetId]);
      const none = await start(ownerUser());
      expect(none.status).toBe(409);
      expect((await refusal(none)).code).toBe('categorize_no_categories');
      expect(await queued()).toBe(0);

      // More categories than one call may offer: its own code and the limit.
      await pool.query('update public.categories set hidden = false where budget_id = $1', [a.budgetId]);
      const groupId = await newGroup(a.budgetId, 'Bulk');
      await pool.query(
        `insert into public.categories (id, budget_id, group_id, name)
         select gen_random_uuid(), $1, $2, 'Bulk ' || n from generate_series(1, $3::int) n`,
        [a.budgetId, groupId, JEV_MAX_OPTIONS + 1],
      );
      const tooMany = await start(ownerUser());
      expect(tooMany.status).toBe(409);
      const capped = await refusal(tooMany);
      expect(capped.code).toBe('categorize_too_many_categories');
      expect(capped.max).toBe(JEV_MAX_OPTIONS);
      expect(await queued()).toBe(0);
    } finally {
      configureSecretBox(null);
    }
  });
});
