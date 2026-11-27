/**
 * One definition of "decided": a row is frozen only by the person's standing
 * decision about it (a category accept still in effect, a transfer accept whose
 * row still points at that account, or a skip). A refused transfer target and a
 * suggestion dismissed as a by-product are not decisions, so accept, the run's
 * write, the queue, the Transfers read and the status count all treat such a row
 * as an ordinary undecided one.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';

import { pool, withTransaction } from '../core/db';
import { configureSecretBox } from '../core/secret-box';
import { dbReady } from '../core/test-gate';
import { httpOnError } from '../core/validate';
import { JEV_MODEL, saveOwnKey, type JevAnswer, type JevCall } from '../jev';
import type { IdentityUser } from '../user';
import { freeCounterpart, linkByUser, setTransferMarks, unlinkTransfers, updateTransactionInClient } from '../budget';
import router from './router';
import { runCategorize } from './run';
import { hourlyUse } from './run-store';
import { runStatus } from './run-status';
import { matcherRowIds, pendingTransferIds } from './store';
import { cleanupFixtures, newAccount, newBudget, newPayee, newTransaction, type BudgetFixture } from './testing';

let acting: IdentityUser;
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', acting);
  return next();
});
app.route('/categorize', router);

let a: BudgetFixture;
const jobRuns: string[] = [];

async function call(method: string, path: string, body?: unknown) {
  acting = { id: a.userId, email: 'owner@decided.test', googleSub: null, role: 'user', status: 'active' };
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, code: (json?.code as string | undefined) ?? null, json };
}
const acceptT = (id: string, account: string) =>
  call('POST', '/categorize/accept', { budget_id: a.budgetId, items: [{ transaction_id: id, transfer_account_id: account }] });
const acceptC = (id: string, category: string) =>
  call('POST', '/categorize/accept', { budget_id: a.budgetId, items: [{ transaction_id: id, category_id: category }] });
const refuse = (id: string, account: string) =>
  call('POST', '/categorize/transfers/refuse', { budget_id: a.budgetId, transaction_id: id, transfer_account_id: account });
type QueueRow = { transaction_id: string; state: string; suggestions: { category_id: string }[] };
const queueRows = async (): Promise<QueueRow[]> =>
  ((await call('GET', `/categorize/queue?budget_id=${a.budgetId}&limit=200`)).json!.rows as QueueRow[]);
const queueRow = async (id: string) => (await queueRows()).find((row) => row.transaction_id === id);
const readPairs = async (): Promise<string[]> => {
  const { json } = await call('GET', `/categorize/transfers?budget_id=${a.budgetId}`);
  return (json!.groups as { transfer_account_id: string; rows: { transaction_id: string }[] }[]).flatMap((g) =>
    g.rows.map((row) => `${row.transaction_id}->${g.transfer_account_id}`),
  );
};
const inRead = async (id: string) => (await readPairs()).some((pair) => pair.startsWith(id));

const tx = (o: Partial<Parameters<typeof newTransaction>[0]>) =>
  newTransaction({ budgetId: a.budgetId, accountId: a.accountId, date: '2026-11-15', amount: -300000, ...o });
async function suggest(id: string, target: { category?: string; account?: string }, rank = 1, confidence = 0.9) {
  await pool.query(
    `insert into public.category_suggestions
       (transaction_id, budget_id, rank, category_id, transfer_account_id, confidence, source, status)
     values ($1, $2, $3, $4, $5, $6, 'jev', 'pending')`,
    [id, a.budgetId, rank, target.category ?? null, target.account ?? null, confidence],
  );
}
const suggestionsOf = async (id: string) =>
  (
    await pool.query<{ rank: number; category_id: string | null; transfer_account_id: string | null; status: string }>(
      'select rank, category_id, transfer_account_id, status from public.category_suggestions where transaction_id = $1 order by rank',
      [id],
    )
  ).rows;
const attemptOf = async (id: string) =>
  (await pool.query<{ outcome: string }>('select outcome from public.categorize_attempts where transaction_id = $1', [id]))
    .rows[0]?.outcome ?? null;

async function runWith(answer: (c: JevCall) => JevAnswer | Promise<JevAnswer>) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into jobs.job_runs (job_type, subject_key, instance_id, input, status)
     values ('categorize_run', $1, 'decided-test', $2::jsonb, 'succeeded') returning id`,
    [a.budgetId, JSON.stringify({ budgetId: a.budgetId })],
  );
  jobRuns.push(rows[0]!.id);
  const calls: JevCall[] = [];
  const progress = await runCategorize(pool, { runId: rows[0]!.id, budgetId: a.budgetId }, {
    classify: async (c) => {
      calls.push(c);
      return answer(c);
    },
  });
  return { progress, calls };
}
const transferAnswer = (c: JevCall): JevAnswer => {
  const option = c.options.find((o) => o.id.startsWith('transfer:'));
  return {
    suggestions: option ? [{ categoryId: null, transferAccountId: option.id.slice('transfer:'.length), confidence: 0.95 }] : [],
    model: JEV_MODEL,
  };
};

beforeEach(async () => {
  if (!dbReady) return;
  configureSecretBox({ current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) });
  a = await newBudget('decided');
  await saveOwnKey(pool, a.userId, 'sk-or-v1-0123456789abcdef');
});
afterAll(async () => {
  if (!dbReady) return;
  configureSecretBox(null);
  if (jobRuns.length) await pool.query('delete from jobs.job_runs where id = any($1::uuid[])', [jobRuns]);
  await cleanupFixtures();
});

describe.skipIf(!dbReady)('one definition of "decided"', () => {
  test('F1: after "not a transfer" an outflow is an ordinary row: category, manual and bundle accepts work', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const out = await tx({ amount: -2100, date: '2026-11-20' });
    await suggest(out, { account: savings }, 1);
    await suggest(out, { category: a.food }, 2);
    expect((await refuse(out, savings)).status).toBe(200);
    expect(await inRead(out)).toBe(false);
    expect((await queueRow(out))?.suggestions.map((s) => s.category_id)).toEqual([a.food]);
    expect((await acceptC(out, a.food)).status).toBe(200);

    const manual = await tx({ amount: -2200, date: '2026-11-20' });
    await suggest(manual, { account: savings }, 1);
    await refuse(manual, savings);
    expect((await acceptC(manual, a.dining)).status).toBe(200);

    const payee = await newPayee(a.budgetId, 'Mercado');
    const plain = await tx({ amount: -3100, date: '2026-11-20', payeeId: payee });
    await suggest(plain, { category: a.food }, 1);
    const refused = await tx({ amount: -3200, date: '2026-11-21', payeeId: payee });
    await suggest(refused, { account: savings }, 1);
    await suggest(refused, { category: a.food }, 2);
    await refuse(refused, savings);
    const bundles = (await call('GET', `/categorize/queue?budget_id=${a.budgetId}&limit=50`)).json!.bundles as {
      bundle_key: string;
      count: number;
      payee_id: string | null;
    }[];
    const bundle = bundles.find((b) => b.payee_id === payee)!;
    expect(bundle.count).toBe(2);
    const res = await call('POST', '/categorize/accept', {
      budget_id: a.budgetId,
      bundle_key: bundle.bundle_key,
      expected_count: bundle.count,
    });
    expect(res.status).toBe(200);
    const cats = await pool.query('select category_id from public.transactions where id = any($1::uuid[])', [[plain, refused]]);
    expect(cats.rows.map((row) => row.category_id)).toEqual([a.food, a.food]);
  });

  test('F2: after a refusal a later run asks an outflow its category and leaves a refused inflow alone', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const card = await newAccount(a.budgetId, 'Card');
    const into = await tx({ accountId: savings, amount: 2400, date: '2026-11-15' });
    await tx({ amount: -2400, date: '2026-11-10' });
    await tx({ accountId: card, amount: -2400, date: '2026-11-11' });
    await suggest(into, { account: a.accountId }, 1);
    await refuse(into, a.accountId);

    const lone = await tx({ amount: -3300, date: '2026-11-22' });
    await suggest(lone, { account: savings }, 1);
    await refuse(lone, savings);

    const { calls } = await runWith((c) =>
      c.facts.amount > 0 ? transferAnswer(c) : { suggestions: [{ categoryId: a.dining, confidence: 0.95 }], model: JEV_MODEL },
    );
    // "Not a transfer" answered the row: the inflow has no other question.
    expect(calls.some((c) => c.facts.amount === 2400)).toBe(false);
    expect((await suggestionsOf(into)).filter((s) => s.status === 'pending')).toEqual([]);
    expect(await inRead(into)).toBe(false);
    expect((await suggestionsOf(lone)).filter((s) => s.status === 'pending').map((s) => s.category_id)).toEqual([a.dining]);
    expect(await attemptOf(lone)).toBe('suggested');
    expect((await queueRow(lone))?.state).toBe('has_suggestions');
  });

  test('F3: a transfer accept undone by the register unlink leaves an undecided, visible, acceptable row', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const out = await tx({ amount: -6100, date: '2026-11-12' });
    await tx({ accountId: savings, amount: 6100, date: '2026-11-17' });
    await suggest(out, { account: savings }, 1);
    await suggest(out, { category: a.dining }, 2);
    expect((await acceptT(out, savings)).status).toBe(200);
    await withTransaction(pool, (c) => unlinkTransfers(c, a.budgetId, [out]));

    // The decision is stale: its CATEGORY suggestions are live again, never the
    // transfer the person just undid. The row is in the category queue — unless
    // the matcher proposes the pair itself, whose own list then shows it.
    expect(await inRead(out)).toBe(false);
    const matcher = (await matcherRowIds(pool, a.budgetId)).includes(out);
    expect(matcher ? await queueRow(out) : (await queueRow(out))?.suggestions.map((s) => s.category_id)).toEqual(
      matcher ? undefined : [a.dining],
    );
    expect((await acceptC(out, a.food)).status).toBe(200);
  });

  test('F3: with no counterpart left, the unlinked row is re-asked and its new answer is stored', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const out = await tx({ amount: -6300, date: '2026-11-12' });
    await suggest(out, { account: savings }, 1);
    await suggest(out, { category: a.dining }, 2);
    // No row in Savings: accept creates the leg, unlink deletes it again.
    expect((await acceptT(out, savings)).status).toBe(200);
    await withTransaction(pool, (c) => unlinkTransfers(c, a.budgetId, [out]));
    expect((await matcherRowIds(pool, a.budgetId)).includes(out)).toBe(false);
    expect((await inRead(out)) || (await queueRow(out)) !== undefined).toBe(true);

    const { calls } = await runWith(() => ({ suggestions: [{ categoryId: a.food, confidence: 0.95 }], model: JEV_MODEL }));
    expect(calls.some((c) => c.facts.amount === -6300)).toBe(true);
    expect((await suggestionsOf(out)).filter((s) => s.status === 'pending').map((s) => s.category_id)).toEqual([a.food]);
    expect((await queueRow(out))?.suggestions.map((s) => s.category_id)).toEqual([a.food]);
    expect((await acceptC(out, a.food)).status).toBe(200);
  });

  test('F4: a marked outflow falls back to its category suggestions; a marked inflow is not listed', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const out = await tx({ amount: -1400, date: '2026-11-20' });
    await suggest(out, { account: savings }, 1);
    await suggest(out, { category: a.food }, 2);
    await setTransferMarks(pool, a.budgetId, [out], 'dismissed');
    expect(await inRead(out)).toBe(false);
    expect((await queueRow(out))?.suggestions.map((s) => s.category_id)).toEqual([a.food]);
    expect((await acceptC(out, a.food)).status).toBe(200);

    // An old "a transfer outside the budget" mark is no answer at all
    // (budget-dt00): the row is not pending, its transfer is listed and can be
    // accepted, and a row with only a category suggestion is in the queue.
    const outside = await tx({ amount: -1401, date: '2026-11-20', mark: 'outside' });
    await suggest(outside, { account: savings }, 1);
    await suggest(outside, { category: a.food }, 2);
    expect((await pendingTransferIds(pool, a.budgetId)).includes(outside)).toBe(false);
    expect(await inRead(outside)).toBe(true);
    expect((await acceptT(outside, savings)).status).toBe(200);
    const outsideCat = await tx({ amount: -1402, date: '2026-11-20', mark: 'outside' });
    await suggest(outsideCat, { category: a.food }, 1);
    expect((await queueRow(outsideCat))?.suggestions.map((s) => s.category_id)).toEqual([a.food]);
    expect((await acceptC(outsideCat, a.food)).status).toBe(200);

    const into = await tx({ accountId: savings, amount: 1450, date: '2026-11-15' });
    await tx({ amount: -1450, date: '2026-11-12' });
    await suggest(into, { account: a.accountId }, 1);
    await setTransferMarks(pool, a.budgetId, [into], 'dismissed');
    expect(await inRead(into)).toBe(false);
    expect(await queueRow(into)).toBeUndefined();
  });

  test('F4: an old "outside" mark withholds nothing from a run: categories and transfers for an outflow, transfers for an inflow', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const out = await tx({ amount: -1601, date: '2026-11-20', mark: 'outside' });
    const into = await tx({ accountId: savings, amount: 1650, date: '2026-11-15', mark: 'outside' });
    // Five days apart: Categorize's window, beyond the matcher's (which would list the pair itself).
    await tx({ amount: -1650, date: '2026-11-10', mark: 'outside' });
    const { calls } = await runWith(() => ({ suggestions: [], model: JEV_MODEL }));
    const asked = (amount: number) => calls.find((c) => c.facts.amount === amount);
    const outCall = asked(-1601);
    expect(outCall).toBeDefined();
    expect(outCall!.options.some((o) => o.id === a.food)).toBe(true);
    expect(outCall!.options.some((o) => o.id === `transfer:${savings}`)).toBe(true);
    const inCall = asked(1650);
    expect(inCall).toBeDefined();
    expect(inCall!.options.map((o) => o.id)).toContain(`transfer:${a.accountId}`);
    expect(await attemptOf(out)).toBe('no_suggestion');
    expect(await attemptOf(into)).toBe('no_suggestion');
  });

  test('F5: the read lists a transfer only when accepting it for THAT account would succeed', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const card = await newAccount(a.budgetId, 'Card');
    const into = await tx({ accountId: savings, amount: 1500, date: '2026-11-15' });
    await tx({ accountId: card, amount: -1500, date: '2026-11-10' });
    await suggest(into, { account: a.accountId }, 1);
    expect(await inRead(into)).toBe(false);
    expect((await acceptT(into, a.accountId)).code).toBe('categorize_transfer_pair_gone');
  });

  test('F5: an inflow is offered only the accounts that hold a free counterpart', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const card = await newAccount(a.budgetId, 'Card');
    await newAccount(a.budgetId, 'Wallet');
    await tx({ accountId: savings, amount: 1600, date: '2026-11-15' });
    await tx({ accountId: card, amount: -1600, date: '2026-11-10' });
    const { calls } = await runWith(() => ({ suggestions: [], model: JEV_MODEL }));
    const inflow = calls.find((c) => c.facts.amount === 1600)!;
    expect(inflow.options.map((o) => o.label)).toEqual(['Transfer / Card', 'Not a transfer']);
  });

  test('F6: the status counts what the run sends (a matcher pair is not sent)', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    await tx({ amount: -500000, date: '2026-11-15' });
    await tx({ accountId: savings, amount: 500000, date: '2026-11-15' });
    const status = await runStatus(pool, a.budgetId);
    const { progress } = await runWith(() => ({ suggestions: [], model: JEV_MODEL }));
    expect({ waiting: status.waiting, candidates: status.candidates }).toEqual({ waiting: progress.total, candidates: progress.total });
    expect(progress.total).toBe(0);
  });

  test('F7: an outflow transfer into a closed account is refused like the register refuses it', async () => {
    const closed = await newAccount(a.budgetId, 'OldCard', { closed: true });
    const out = await tx({ amount: -333000 });
    await tx({ accountId: closed, amount: 333000, date: '2026-11-13' });
    const res = await acceptT(out, closed);
    expect({ status: res.status, code: res.code }).toEqual({ status: 409, code: 'account_closed' });
    const row = await pool.query('select transfer_account_id from public.transactions where id = $1', [out]);
    expect(row.rows[0].transfer_account_id).toBeNull();
  });

  test('F8: the budget counterpart rule names no categorize table, and the register link ignores refusals', async () => {
    expect(freeCounterpart({ row: 'o', amount: '-t.amount', date: 't.date', days: '7' })).not.toContain(
      'categorize',
    );
    expect(readFileSync(`${import.meta.dir}/../budget/store/transfers.ts`, 'utf8')).not.toContain('categorize_');
    const savings = await newAccount(a.budgetId, 'Savings');
    const cp = await tx({ date: '2026-11-10' });
    const into = await tx({ accountId: savings, amount: 300000, date: '2026-11-15' });
    await refuse(into, a.accountId);
    const res = await withTransaction(pool, (c) =>
      linkByUser(c, a.budgetId, [{ transaction_id: into, account_id: a.accountId }], false),
    );
    expect(res.linked).toContain(cp);
  });

  test('refusing a pair, then accepting it, answers a transfer code; refusing the own account is a 400', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const out = await tx({ amount: -2300, date: '2026-11-20' });
    await suggest(out, { account: savings }, 1);
    await refuse(out, savings);
    expect((await acceptT(out, savings)).code).toBe('categorize_transfer_refused');
    const own = await refuse(await tx({ amount: -6 }), a.accountId);
    expect({ status: own.status, code: own.code }).toEqual({ status: 400, code: 'cannot_transfer_to_same_account' });
  });

  test('a row the run did not send costs nothing of the hourly allowance', async () => {
    await tx({ amount: -4100, date: '2026-11-20' });
    await runWith(() => ({ suggestions: [{ categoryId: a.food, confidence: 0.9 }], model: JEV_MODEL }));
    const used = (await hourlyUse(pool, a.budgetId)).used;
    const raced = await tx({ amount: -4200, date: '2026-11-21' });
    // The person skips the row while Jev is answering: the answer is dropped.
    await runWith(async () => {
      await pool.query(
        `insert into public.categorize_decisions (transaction_id, budget_id, kind, category_id, user_id) values ($1, $2, 'skip', null, $3)`,
        [raced, a.budgetId, a.userId],
      );
      return { suggestions: [{ categoryId: a.food, confidence: 0.9 }], model: JEV_MODEL };
    });
    expect(used).toBe(1);
    expect((await hourlyUse(pool, a.budgetId)).used).toBe(1);
  });

  test('G1: "not a transfer" answers for the ROW: an outflow is asked categories only, nothing transfers again', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const card = await newAccount(a.budgetId, 'Card');
    const out = await tx({ amount: -4400, date: '2026-11-20' });
    await suggest(out, { account: savings }, 1);
    expect((await refuse(out, savings)).status).toBe(200);
    const { calls } = await runWith(() => ({ suggestions: [], model: JEV_MODEL }));
    const asked = calls.find((c) => c.facts.amount === -4400)!;
    expect(asked.options.some((o) => o.id.startsWith('transfer:'))).toBe(false);
    // An answer naming another account (a stored leftover, or another writer's) is never shown or accepted.
    await pool.query('delete from public.category_suggestions where transaction_id = $1', [out]);
    await suggest(out, { account: card }, 1, 0.98);
    expect(await inRead(out)).toBe(false);
    expect(await queueRow(out)).toBeDefined();
    expect((await acceptT(out, card)).code).toBe('categorize_transfer_refused');
  });

  test('G1: a refused inflow is never asked again, nor listed or accepted for another account', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const card = await newAccount(a.budgetId, 'Card');
    const into = await tx({ accountId: savings, amount: 2500, date: '2026-11-15' });
    await tx({ amount: -2500, date: '2026-11-10' });
    await tx({ accountId: card, amount: -2500, date: '2026-11-11' });
    await suggest(into, { account: a.accountId }, 1);
    expect((await refuse(into, a.accountId)).status).toBe(200);
    const { calls } = await runWith(transferAnswer);
    expect(calls.some((c) => c.facts.amount === 2500)).toBe(false);
    await suggest(into, { account: card }, 2, 0.98);
    expect(await inRead(into)).toBe(false);
    expect((await acceptT(into, card)).code).toBe('categorize_transfer_refused');
  });

  test('G2: a transfer unlinked in the register is not offered again; its category suggestions are', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const out = await tx({ amount: -6400, date: '2026-11-12' });
    await suggest(out, { account: savings }, 1);
    await suggest(out, { category: a.dining }, 2);
    expect((await acceptT(out, savings)).status).toBe(200);
    await withTransaction(pool, (c) => unlinkTransfers(c, a.budgetId, [out]));
    expect(await inRead(out)).toBe(false);
    expect((await queueRow(out))?.suggestions.map((s) => s.category_id)).toEqual([a.dining]);
  });

  test('G2: a category filed over a Jev transfer, then cleared in the register, does not revive the transfer', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const out = await tx({ amount: -6500, date: '2026-11-12' });
    await suggest(out, { account: savings }, 1);
    await suggest(out, { category: a.food }, 2);
    expect((await acceptC(out, a.food)).status).toBe(200);
    await withTransaction(pool, (c) =>
      updateTransactionInClient(c, { budgetId: a.budgetId, id: out, patch: { category_id: null }, subtransactions: undefined }),
    );
    expect(await inRead(out)).toBe(false);
    expect((await queueRow(out))?.suggestions.map((s) => s.category_id)).toEqual([a.food]);
  });

  test('G2: the page Undo of a transfer accept still restores the transfer suggestion', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const out = await tx({ amount: -6600, date: '2026-11-12' });
    await suggest(out, { account: savings }, 1);
    expect((await acceptT(out, savings)).status).toBe(200);
    expect((await call('POST', '/categorize/undo', { budget_id: a.budgetId, transaction_ids: [out] })).status).toBe(200);
    expect(await readPairs()).toContain(`${out}->${savings}`);
  });

  test('G3: a row the matcher suggests is not in the queue or its counts; dismissing the pair brings it back', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const out = await tx({ amount: -510000, date: '2026-11-15' });
    const into = await tx({ accountId: savings, amount: 510000, date: '2026-11-15' });
    expect((await matcherRowIds(pool, a.budgetId)).includes(out)).toBe(true);
    expect((await pendingTransferIds(pool, a.budgetId)).includes(out)).toBe(false);
    const page = async () => (await call('GET', `/categorize/queue?budget_id=${a.budgetId}&limit=200`)).json!;
    const before = await page();
    expect((before.rows as QueueRow[]).map((row) => row.transaction_id)).not.toContain(out);
    expect((before.counts as { left_to_categorize: number }).left_to_categorize).toBe(0);

    await setTransferMarks(pool, a.budgetId, [out, into], 'dismissed');
    const after = await page();
    expect((after.rows as QueueRow[]).map((row) => row.transaction_id)).toContain(out);
    expect((after.counts as { left_to_categorize: number }).left_to_categorize).toBe(1);
    const { calls } = await runWith(() => ({ suggestions: [], model: JEV_MODEL }));
    expect(calls.map((c) => c.facts.amount)).toEqual([-510000]);
  });

  test('G4: the hourly use counts calls, so a row sent twice in the hour counts twice', async () => {
    const out = await tx({ amount: -4300, date: '2026-11-20' });
    await runWith(() => ({ suggestions: [], model: JEV_MODEL }));
    // New facts make the row a candidate again within the same hour.
    await pool.query('update public.transactions set memo = $2 where id = $1', [out, 'changed']);
    const { calls } = await runWith(() => ({ suggestions: [], model: JEV_MODEL }));
    expect(calls.length).toBe(1);
    expect((await hourlyUse(pool, a.budgetId)).used).toBe(2);
    // Never over-counts: a window that started more than an hour ago counts nothing.
    await pool.query(
      `update public.categorize_attempts set hour_started_at = now() - interval '61 minutes' where transaction_id = $1`,
      [out],
    );
    expect((await hourlyUse(pool, a.budgetId)).used).toBe(0);
  });

  test('0129 and 0130 re-run cleanly over rows only the relaxed constraints allow', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const out = await tx({ amount: -8100, date: '2026-11-20' });
    await pool.query(
      `insert into public.category_suggestions (transaction_id, budget_id, rank, category_id, transfer_account_id, confidence, source, status)
       values ($1, $2, 1, $3, $4, 0.9, 'jev', 'pending')`,
      [out, a.budgetId, a.food, savings],
    );
    await pool.query(
      `insert into public.categorize_decisions (transaction_id, budget_id, kind, category_id, transfer_account_id, user_id)
       values ($1, $2, 'skip', null, $3, $4)`,
      [out, a.budgetId, savings, a.userId],
    );
    for (const file of ['0129_category_suggestions_transfer_target.sql', '0130_categorize_transfer_refusals.sql']) {
      const sql = readFileSync(`${import.meta.dir}/../../db/migrations/${file}`, 'utf8');
      await withTransaction(pool, (c) => c.query(sql));
    }
  });
});
