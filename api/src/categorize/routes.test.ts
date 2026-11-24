/**
 * HTTP tests of the Categorize page: the queue's states/bundles/threshold,
 * accept/undo/skip, run start/status and the settings. Every handler's result
 * is validated against its contract output by the test preload.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { storeOwnKey } from '../ai';
import { configureSecretBox } from '../core/secret-box';
import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { httpOnError } from '../core/validate';
import type { IdentityUser } from '../user';
import router from './router';
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
const status = (who: IdentityUser, budgetId = a.budgetId) => call(who, 'GET', `/categorize/run?budget_id=${budgetId}`);
const accept = (who: IdentityUser, items: unknown[], budgetId = a.budgetId) =>
  call(who, 'POST', '/categorize/accept', { budget_id: budgetId, items });
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
    [transactionId, a.budgetId, opts.rank ?? 1, categoryId, opts.confidence ?? 0.9, opts.reason ?? 'why', opts.source ?? 'ai', opts.status ?? 'pending'],
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
  configureSecretBox(null);
  if (!dbReady) return;
  for (const id of budgetIds) await pool.query('delete from jobs.job_runs where subject_key = $1', [id]);
  await cleanupFixtures();
});

describe.skipIf(!dbReady)('queue', () => {
  test('distinguishes every state, newest first, without needing an AI key', async () => {
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
      { category_id: a.food, category_name: 'Food', confidence: 0.94, reason: 'why', source: 'ai' },
    ]);
    expect(byId.get(below)).toMatchObject({ state: 'below_threshold', suggestions: [] });
    expect(byId.get(none)).toMatchObject({ state: 'no_suggestion' });
    expect(byId.get(failed)).toMatchObject({ state: 'failed' });
    expect(byId.get(fresh)).toMatchObject({ state: 'not_classified' });
    expect(page.counts).toEqual({ left_to_categorize: 5, above_threshold: 1, no_suggestion: 4 });
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
    expect(bundle).toMatchObject({ count: 3, total_milliunits: -6000, first_date: '2026-11-01', last_date: '2026-11-03' });
    expect(bundle.transaction_ids).toEqual([ids[2], ids[1], ids[0]]);
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
    expect(suggestions).toEqual([{ rank: 1, status: 'accepted', source: 'ai' }, { rank: 2, status: 'dismissed', source: 'ai' }]);
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


  test('repeat accept keeps the model suggestion and undo restores it to pending (no manual overwrite)', async () => {
    const t = await txn({ payeeId: await newPayee('Repeat model') });
    await suggest(t, a.food, { rank: 1, source: 'ai' });
    expect((await (await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }])).json()).accepted).toBe(1);
    const repeat = await accept(ownerUser(), [{ transaction_id: t, category_id: a.food }]);
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).accepted).toBe(0);
    expect((await pool.query('select rank, status, source from public.category_suggestions where transaction_id = $1', [t])).rows)
      .toEqual([{ rank: 1, status: 'accepted', source: 'ai' }]);
    const back = await undo(ownerUser(), [t]);
    expect(await back.json()).toEqual({ restored: 1, transaction_ids: [t], skipped: [] });
    expect((await pool.query('select rank, status, source from public.category_suggestions where transaction_id = $1', [t])).rows)
      .toEqual([{ rank: 1, status: 'pending', source: 'ai' }]);
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
    expect(await res.json()).toEqual({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'no_decision' }] });
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

    const none = await txn({ payeeId: await newPayee('Nothing to skip') });
    const nothing = await skip(ownerUser(), none);
    expect(nothing.status).toBe(409);
    expect((await nothing.json()).code).toBe('categorize_nothing_to_skip');
  });
});

describe.skipIf(!dbReady)('run start and status', () => {
  test('start without a usable key is a clear 409, and status says why', async () => {
    const before = await call(memberUser(), 'POST', '/categorize/run', { budget_id: a.budgetId });
    expect(before.status).toBe(409);
    expect((await before.json()).code).toBe('categorize_ai_unavailable');
    expect((await pool.query('select 1 from jobs.job_runs where subject_key = $1', [a.budgetId])).rowCount).toBe(0);

    const st = await status(memberUser());
    expect(st.status).toBe(200);
    expect(await st.json()).toMatchObject({
      active: null,
      last_finished: null,
      ai: { available: false, reason: 'own_key_required', provider: null, model: null, source: null },
    });
  });

  test('any member may start, the run uses the owner\'s key, and starts coalesce', async () => {
    configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
    try {
      await storeOwnKey(pool, a.userId, 'openrouter', 'sk-or-v1-test-key-123456', 'test-model');
      const first = await call(memberUser(), 'POST', '/categorize/run', { budget_id: a.budgetId });
      expect(first.status).toBe(200);
      const started = await first.json();
      expect(started.created).toBe(true);
      expect(started.run).toMatchObject({ status: 'queued', done: 0, total: 0, requested_by: memberId });

      const row = (await pool.query('select tenant_id, requested_by from jobs.job_runs where id = $1', [started.run.id])).rows[0];
      expect(row).toEqual({ tenant_id: a.userId, requested_by: memberId });

      const second = await call(ownerUser(), 'POST', '/categorize/run', { budget_id: a.budgetId });
      expect(second.status).toBe(200);
      const joined = await second.json();
      expect(joined.created).toBe(false);
      expect(joined.run.id).toBe(started.run.id);

      const st = await (await status(memberUser())).json();
      expect(st.ai).toEqual({ available: true, reason: null, provider: 'openrouter', model: 'test-model', source: 'own' });
      expect(st.active.id).toBe(started.run.id);
      expect(st.active.status).toBe('queued');
    } finally {
      configureSecretBox(null);
    }
  });

  test('status reports active progress and the last finished run', async () => {
    const progressBudget = a.budgetId;
    // Active: a queued run plus a worker-written progress row.
    const activeId = crypto.randomUUID();
    await pool.query(
      `insert into jobs.job_runs (id, job_type, subject_key, tenant_id, instance_id, input, requested_by)
       values ($1, 'categorize_run', $2, $3, 'test', '{}'::jsonb, $4)`,
      [activeId, progressBudget, a.userId, a.userId],
    );
    await pool.query(
      `insert into public.categorize_run_progress (run_id, budget_id, done, total) values ($1, $2, 7, 20)`,
      [activeId, progressBudget],
    );
    let st = await (await status(memberUser())).json();
    expect(st.active).toMatchObject({ id: activeId, status: 'queued', done: 7, total: 20 });

    // Finish it with a result; a second run is now the "last finished" one.
    await pool.query(
      `update jobs.job_runs set status = 'succeeded', started_at = now(), finished_at = now(),
              result = $2::jsonb, user_message = null where id = $1`,
      [activeId, JSON.stringify({ total: 20, remaining: 3, done: 20, suggested: 17, rule: 1, empty: 1, skipped: 1, failed: 0, input_tokens: 1, output_tokens: 1, stopped: null })],
    );
    st = await (await status(memberUser())).json();
    expect(st.active).toBeNull();
    expect(st.last_finished).toMatchObject({
      id: activeId, status: 'succeeded', total: 20, done: 20, remaining: 3,
      suggested: 17, rule: 1, empty: 1, skipped: 1, failed: 0, user_message: null,
    });
  });
});

describe.skipIf(!dbReady)('access', () => {
  test('a non-member gets 404 on every operation and nothing changes', async () => {
    const t = await txn({ payeeId: await newPayee('Private') });
    await suggest(t, a.food);
    const requests: [string, string, unknown?][] = [
      ['GET', `/categorize/queue?budget_id=${a.budgetId}`],
      ['GET', `/categorize/run?budget_id=${a.budgetId}`],
      ['POST', '/categorize/run', { budget_id: a.budgetId }],
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

  test('a member who is not the owner reads the page and can start the owner-key run', async () => {
    const t = await txn({ payeeId: await newPayee('Member Read') });
    await suggest(t, a.food);
    const page = await queueJson(memberUser());
    expect(page.rows.length).toBe(1);
    expect((await status(memberUser())).status).toBe(200);

    // The member cannot see a foreign budget either.
    const foreign = await call(memberUser(), 'GET', `/categorize/queue?budget_id=${other.budgetId}`);
    expect(foreign.status).toBe(404);
  });
});
