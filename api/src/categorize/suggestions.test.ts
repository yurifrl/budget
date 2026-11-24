/**
 * The read path budget-edxg consumes: pending suggestions at/above a
 * threshold, joined with the transaction/category/account the page shows, and
 * scoped to one budget. Also the run start/status helpers (actor derivation,
 * coalescing, the ledger read) and the filters that keep hidden/deleted
 * taxonomy out of a queue a person sees.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { storeOwnKey } from '../ai';
import { setProviders } from '../ai/providers';
import { pool } from '../core/db';
import { configureSecretBox } from '../core/secret-box';
import { dbReady } from '../core/test-gate';
import { HttpError } from '../core/validate';
import { runChunk } from './chunk';
import { answer, fakeProviders } from './testing';
import { categorizeRunStatus, startCategorizeRun } from './job';
import { listAttempts, listCategoryChoices, listSuggestions } from './store';
import { cleanupFixtures, newAccount, newBudget, newTransaction, newUser, type BudgetFixture } from './testing';

const KEY = 'sk-test-read-0123456789abcdef';
const MAX = { date: '9999-12-31', id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
let fixture: BudgetFixture;

beforeEach(async () => {
  if (!dbReady) return;
  await cleanupFixtures();
  fixture = await newBudget('read-a');
  configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
  await storeOwnKey(pool, fixture.userId, 'openai', KEY, 'fake-model');
});

afterAll(async () => {
  if (!dbReady) return;
  setProviders(null);
  configureSecretBox(null);
  await cleanupFixtures();
});

const options = { minConfidence: 0, limit: 50, offset: 0 };
const run = (total = 1, force = false) =>
  runChunk(pool, { budgetId: fixture.budgetId, force, snapshot: MAX, cursor: null, limit: 10, total });

describe.skipIf(!dbReady)('reading category suggestions', () => {
  test('returns pending suggestions at/above the threshold with the joined page fields', async () => {
    setProviders(fakeProviders(() => answer([{ category_id: fixture.food, confidence: 0.8, reason: 'market' }])).table);
    const txn = await newTransaction({
      budgetId: fixture.budgetId,
      accountId: fixture.accountId,
      date: '2026-11-01',
      amount: -4200,
      memo: 'weekly shop',
      importPayeeName: 'MERCADO',
      rawPayload: {
        operationType: 'PIX',
        merchant: { name: 'Mercado Central', businessName: 'Mercado Central LTDA', cnpj: '12.345.678/0001-90', category: 'Groceries' },
        paymentData: { paymentMethod: 'PIX', receiver: { name: 'Mercado Central' } },
      },
    });
    await run();

    const all = await listSuggestions(pool, fixture.budgetId, options);
    expect(all.total).toBe(1);
    expect(all.rows[0]).toMatchObject({
      transaction_id: txn,
      rank: 1,
      category_id: fixture.food,
      category_name: 'Food',
      group_name: 'Everyday',
      confidence: 0.8,
      reason: 'market',
      source: 'ai',
      provider: 'openai',
      model: 'fake-model',
      status: 'pending',
      date: '2026-11-01',
      amount_milliunits: -4200,
      payee: 'MERCADO',
      account_name: 'Checking',
      memo: 'weekly shop',
      // The latest attempt, so the page can show "classified" next to the row.
      attempt: { outcome: 'suggested', error_kind: null, attempts: 1, model: 'fake-model', last_attempt_at: expect.any(String) },
      // The merchant panel's facts, typed and optional, straight from
      // raw_payload; no location fields exist in the provider payload.
      bank: {
        operation_type: 'PIX',
        merchant: {
          name: 'Mercado Central',
          legal_name: 'Mercado Central LTDA',
          cnpj: '12.345.678/0001-90',
          category: 'Groceries',
        },
        payment: { method: 'PIX', counterparty_name: 'Mercado Central' },
      },
    });

    expect((await listSuggestions(pool, fixture.budgetId, { ...options, minConfidence: 0.85 })).total).toBe(0);
    expect((await listSuggestions(pool, fixture.budgetId, { ...options, transactionId: txn })).total).toBe(1);
    expect((await listSuggestions(pool, fixture.budgetId, { ...options, transactionId: crypto.randomUUID() })).total).toBe(0);
  });

  test('a classified-empty row is distinguishable from one never classified', async () => {
    setProviders(fakeProviders(() => answer([])).table);
    const empty = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-06', amount: -110 });
    await run();

    // No suggestion row to show...
    expect(await listSuggestions(pool, fixture.budgetId, options)).toEqual({ rows: [], total: 0 });
    // ...but the attempt says it WAS classified, with no suggestion.
    const attempts = await listAttempts(pool, fixture.budgetId, { limit: 50, offset: 0 });
    expect(attempts.total).toBe(1);
    expect(attempts.rows[0]).toMatchObject({
      transaction_id: empty,
      outcome: 'no_suggestion',
      error_kind: null,
      attempts: 1,
      model: 'fake-model',
    });
    expect((await listAttempts(pool, fixture.budgetId, { transactionId: empty, limit: 10, offset: 0 })).total).toBe(1);

    // A transaction with no attempt row is "not classified yet".
    const never = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-07', amount: -120 });
    expect(await listAttempts(pool, fixture.budgetId, { transactionId: never, limit: 10, offset: 0 })).toEqual({ rows: [], total: 0 });
  });

  test('card-payment envelopes and internal categories are not offered to the model', async () => {
    const { newCategory, newGroup } = await import('./testing');
    const ccpGroup = await newGroup(fixture.budgetId, 'Credit Card Payments');
    await pool.query('update public.category_groups set is_credit_card_payments = true, internal = true where id = $1', [ccpGroup]);
    const payment = await newCategory(fixture.budgetId, ccpGroup, 'Nubank');
    const internalGroup = await newGroup(fixture.budgetId, 'System');
    await pool.query('update public.category_groups set internal = true where id = $1', [internalGroup]);
    const internalCategory = await newCategory(fixture.budgetId, internalGroup, 'Hidden system');
    const flagged = await newCategory(fixture.budgetId, fixture.groupId, 'Internal flag');
    await pool.query('update public.categories set internal = true where id = $1', [flagged]);

    const choices = await listCategoryChoices(pool, fixture.budgetId);
    const ids = new Set(choices.map((choice) => choice.id));
    expect(ids.has(payment)).toBe(false);
    expect(ids.has(internalCategory)).toBe(false);
    expect(ids.has(flagged)).toBe(false);
    expect(ids.has(fixture.food)).toBe(true);
  });

  test('another budget never sees these suggestions', async () => {
    setProviders(fakeProviders(() => answer([{ category_id: fixture.food, confidence: 0.8 }])).table);
    await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-02', amount: -100 });
    await run();
    const other = await newBudget('read-b');
    expect(await listSuggestions(pool, other.budgetId, options)).toEqual({ rows: [], total: 0 });

    // A hand-entered row has no bank payload: the panel fields are absent.
    await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-07', amount: -150 });
    setProviders(fakeProviders(() => answer([{ category_id: fixture.food, confidence: 0.8 }])).table);
    await run(2);
    const manual = (await listSuggestions(pool, fixture.budgetId, options)).rows.find((row) => row.amount_milliunits === -150);
    expect(manual?.bank).toBeNull();
  });

  test('decided rows leave the pending queue; a categorized transaction drops out', async () => {
    setProviders(fakeProviders(() => answer([{ category_id: fixture.food, confidence: 0.8 }])).table);
    const decided = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-03', amount: -200 });
    const categorized = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-04', amount: -300 });
    await run(2);

    await pool.query(`update public.category_suggestions set status = 'accepted' where transaction_id = $1`, [decided]);
    await pool.query('update public.transactions set category_id = $2 where id = $1', [categorized, fixture.food]);

    expect(await listSuggestions(pool, fixture.budgetId, options)).toEqual({ rows: [], total: 0 });
    expect((await listSuggestions(pool, fixture.budgetId, { ...options, status: 'accepted' })).total).toBe(1);
  });

  test('a hidden/deleted category, group or account never reaches the queue', async () => {
    setProviders(fakeProviders(() => answer([{ category_id: fixture.food, confidence: 0.8 }])).table);
    const txn = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-05', amount: -400 });
    await run();
    expect((await listSuggestions(pool, fixture.budgetId, options)).total).toBe(1);

    // Hidden after the run: the read path filters it, not only the writer.
    await pool.query('update public.categories set hidden = true where id = $1', [fixture.food]);
    expect((await listSuggestions(pool, fixture.budgetId, options)).total).toBe(0);
    await pool.query('update public.categories set hidden = false where id = $1', [fixture.food]);
    await pool.query('update public.category_groups set hidden = true where id = $1', [fixture.groupId]);
    expect((await listSuggestions(pool, fixture.budgetId, options)).total).toBe(0);
    await pool.query('update public.category_groups set hidden = false where id = $1', [fixture.groupId]);

    const gone = await newAccount(fixture.budgetId, 'Gone');
    await pool.query('update public.transactions set account_id = $2 where id = $1', [txn, gone]);
    await pool.query('update public.accounts set deleted = true where id = $1', [gone]);
    expect((await listSuggestions(pool, fixture.budgetId, options)).total).toBe(0);
  });

  test('a non-uuid transaction id is a validation error, not a database error', async () => {
    const error = await listSuggestions(pool, fixture.budgetId, { ...options, transactionId: 'txn_1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).code).toBe('invalid_transaction_id');
  });

  test('migration 0111 adds the category_id index', async () => {
    const { rows } = await pool.query(`select to_regclass('public.category_suggestions_category_idx') as idx`);
    expect(rows[0].idx).not.toBeNull();
  });

  test('migration 0112 adds the attempts table and its budget index', async () => {
    const { rows } = await pool.query(
      `select to_regclass('public.categorize_attempts') as tbl, to_regclass('public.categorize_attempts_budget_outcome_idx') as idx`,
    );
    expect(rows[0].tbl).not.toBeNull();
    expect(rows[0].idx).not.toBeNull();
  });
});

describe.skipIf(!dbReady)('starting and reading a run', () => {
  test('concurrent starts join one run per budget and the status follows the ledger', async () => {
    const member = await newUser('read-member');
    const first = await startCategorizeRun(pool, { budgetId: fixture.budgetId, requestedBy: member });
    const second = await startCategorizeRun(pool, { budgetId: fixture.budgetId, requestedBy: member });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    // F10: the ledger tenant is the budget OWNER (whose key pays), not the
    // member who asked for the run.
    expect(first.run.tenant_id).toBe(fixture.userId);
    expect(first.run.requested_by).toBe(member);
    expect(first.run.input).toEqual({ force: false });

    const other = await newBudget('run-other');
    const elsewhere = await startCategorizeRun(pool, { budgetId: other.budgetId, requestedBy: other.userId });
    expect(elsewhere.run.id).not.toBe(first.run.id);

    const active = await categorizeRunStatus(pool, fixture.budgetId);
    expect(active.active?.id).toBe(first.run.id);
    expect(active.lastFinished).toBeNull();

    await pool.query(
      `update jobs.job_runs set status = 'succeeded', finished_at = now(), result = $2::jsonb where id = $1`,
      [first.run.id, JSON.stringify({ total: 0, done: 0 })],
    );
    const after = await categorizeRunStatus(pool, fixture.budgetId);
    expect(after.active).toBeNull();
    expect(after.lastFinished?.id).toBe(first.run.id);
  });

  test('an unknown budget is a 404, not a run for nobody', async () => {
    const error = await startCategorizeRun(pool, { budgetId: crypto.randomUUID(), requestedBy: fixture.userId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
  });
});
