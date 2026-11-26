/**
 * The read path budget-edxg consumes: pending suggestions at/above a
 * threshold, joined with the transaction/category/account the page shows, and
 * scoped to one budget, and the filters that keep hidden/deleted
 * taxonomy out of a queue a person sees.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { HttpError } from '../core/validate';
import { listAttempts, listSuggestions } from './store';
import { cleanupFixtures, newAccount, newBudget, newTransaction, type BudgetFixture } from './testing';

let fixture: BudgetFixture;

beforeEach(async () => {
  if (!dbReady) return;
  await cleanupFixtures();
  fixture = await newBudget('read-a');
});

afterAll(async () => {
  if (!dbReady) return;
  await cleanupFixtures();
});

const options = { minConfidence: 0, limit: 50, offset: 0 };

describe.skipIf(!dbReady)('reading category suggestions', () => {
  test('returns pending suggestions at/above the threshold with the joined page fields', async () => {
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
      status: 'pending',
      date: '2026-11-01',
      amount_milliunits: -4200,
      payee: 'MERCADO',
      account_name: 'Checking',
      memo: 'weekly shop',
      // The latest attempt, so the page can show "classified" next to the row.
      attempt: { outcome: 'suggested', error_kind: null, attempts: 1, last_attempt_at: expect.any(String) },
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
    const empty = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-06', amount: -110 });

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
    });
    expect((await listAttempts(pool, fixture.budgetId, { transactionId: empty, limit: 10, offset: 0 })).total).toBe(1);

    // A transaction with no attempt row is "not classified yet".
    const never = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-07', amount: -120 });
    expect(await listAttempts(pool, fixture.budgetId, { transactionId: never, limit: 10, offset: 0 })).toEqual({ rows: [], total: 0 });
  });

  test('another budget never sees these suggestions', async () => {
    await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-02', amount: -100 });
    const other = await newBudget('read-b');
    expect(await listSuggestions(pool, other.budgetId, options)).toEqual({ rows: [], total: 0 });

    // A hand-entered row has no bank payload: the panel fields are absent.
    await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-07', amount: -150 });
    const manual = (await listSuggestions(pool, fixture.budgetId, options)).rows.find((row) => row.amount_milliunits === -150);
    expect(manual?.bank).toBeNull();
  });

  test('decided rows leave the pending queue; a categorized transaction drops out', async () => {
    const decided = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-03', amount: -200 });
    const categorized = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-04', amount: -300 });

    await pool.query(`update public.category_suggestions set status = 'accepted' where transaction_id = $1`, [decided]);
    await pool.query('update public.transactions set category_id = $2 where id = $1', [categorized, fixture.food]);

    expect(await listSuggestions(pool, fixture.budgetId, options)).toEqual({ rows: [], total: 0 });
    expect((await listSuggestions(pool, fixture.budgetId, { ...options, status: 'accepted' })).total).toBe(1);
  });

  test('a hidden/deleted category, group or account never reaches the queue', async () => {
    const txn = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-05', amount: -400 });
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
