/**
 * The write rules of a suggestion set, at the store: every row carries the
 * facts fingerprint the attempt table stores (so a later run can tell "same
 * facts" from "changed"), the write re-reads the transaction under its lock
 * (a row categorized or decided in the meantime is left alone), and a category
 * the budget may not use is dropped instead of stored.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { recordAttempt, replaceSuggestions } from './store';
import {
  cleanupFixtures,
  newAccount,
  newBudget,
  newSuggestion,
  newTransaction,
  suggestionsOf,
  type BudgetFixture,
} from './testing';

const jobRuns: string[] = [];

let b: BudgetFixture;
let runId: string;

beforeEach(async () => {
  b = await newBudget('store-writes');
  // The attempts table points at the ledger run that made the attempt.
  const { rows } = await pool.query<{ id: string }>(
    `insert into jobs.job_runs (job_type, subject_key, instance_id, input, status)
     values ('categorize_run', $1, 'store-writes-test', '{}'::jsonb, 'succeeded') returning id`,
    [b.budgetId],
  );
  runId = rows[0]!.id;
  jobRuns.push(runId);
});

afterAll(async () => {
  if (!dbReady) return;
  await pool.query('delete from jobs.job_runs where id = any($1::uuid[])', [jobRuns.splice(0)]);
  await cleanupFixtures();
});

const row = (categoryId: string, confidence = 0.9) => ({
  target: { kind: 'category' as const, categoryId },
  confidence,
  reason: null,
  source: 'jev' as const,
  provider: 'jev',
  model: 'typesafe/jev-1.13',
});

/** The fingerprints the suggestion rows and the attempt row of one transaction carry. */
async function fingerprints(transactionId: string): Promise<{ suggestions: string[]; attempt: string | null }> {
  const written = await pool.query<{ input_fingerprint: string | null }>(
    'select input_fingerprint from public.category_suggestions where transaction_id = $1 order by rank',
    [transactionId],
  );
  const attempt = await pool.query<{ input_fingerprint: string }>(
    'select input_fingerprint from public.categorize_attempts where transaction_id = $1',
    [transactionId],
  );
  return {
    suggestions: written.rows.map((writtenRow) => writtenRow.input_fingerprint ?? ''),
    attempt: attempt.rows[0]?.input_fingerprint ?? null,
  };
}

describe.skipIf(!dbReady)('writing a suggestion set', () => {
  test('every written row carries the same facts fingerprint the attempt records', async () => {
    const txn = await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-01',
      amount: -4200,
      memo: 'shop',
    });
    expect(await replaceSuggestions(pool, b.budgetId, txn, [row(b.food), row(b.dining, 0.4)])).toBe(2);
    await recordAttempt(pool, b.budgetId, txn, runId, {
      outcome: 'suggested',
      errorKind: null,
      model: 'typesafe/jev-1.13',
      attempts: 'reset',
    });

    const prints = await fingerprints(txn);
    const attempt = prints.attempt ?? '';
    expect(attempt).toBeString();
    expect(prints.suggestions).toEqual([attempt, attempt]);
  });

  test('a transaction categorized between the read and the write stores nothing', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-02', amount: -4100 });
    // Another writer (the register, the MCP tool) settles the row first.
    await pool.query('update public.transactions set category_id = $2 where id = $1', [txn, b.food]);

    expect(await replaceSuggestions(pool, b.budgetId, txn, [row(b.food)])).toBeNull();
    expect(await suggestionsOf(txn)).toEqual([]);
  });

  test('a category the budget may not use is dropped, and the ranks stay contiguous', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-03', amount: -4000 });
    // The model answered out of a list that went stale: a hidden category first.
    expect(await replaceSuggestions(pool, b.budgetId, txn, [row(b.hidden), row(b.food, 0.6)])).toBe(1);

    const stored = await suggestionsOf(txn);
    expect(stored.map((suggestion) => [suggestion.category_id, suggestion.rank])).toEqual([[b.food, 1]]);
  });

  test('a set the person answered (a standing decision) is not overwritten', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-04', amount: -3900 });
    await newSuggestion({ transactionId: txn, budgetId: b.budgetId, categoryId: b.food, status: 'dismissed' });
    await pool.query(
      `insert into public.categorize_decisions (transaction_id, budget_id, kind, category_id) values ($1, $2, 'skip', null)`,
      [txn, b.budgetId],
    );

    expect(await replaceSuggestions(pool, b.budgetId, txn, [row(b.dining)])).toBeNull();
    expect((await suggestionsOf(txn)).map((suggestion) => suggestion.status)).toEqual(['dismissed']);
  });

  test('a non-pending suggestion is no decision: an undecided row takes the new answer', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-04', amount: -3800 });
    await newSuggestion({ transactionId: txn, budgetId: b.budgetId, categoryId: b.food, status: 'dismissed' });

    expect(await replaceSuggestions(pool, b.budgetId, txn, [row(b.dining)])).toBe(1);
    expect((await suggestionsOf(txn)).map((suggestion) => [suggestion.category_id, suggestion.status])).toEqual([
      [b.dining, 'pending'],
    ]);
  });

  test('V8: a released build’s upsert that names only the category still lands', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-05', amount: -4100 });
    const savings = await newAccount(b.budgetId, 'Savings');
    // The row already carries a transfer answer, then a build that predates the
    // second target column upserts rank 1 naming only the category. A strict
    // "exactly one target" check would make that legitimate write fail.
    await pool.query(
      `insert into public.category_suggestions
         (transaction_id, budget_id, rank, transfer_account_id, confidence, reason, source, status)
       values ($1, $2, 1, $3, 0.9, null, 'jev', 'pending')`,
      [txn, b.budgetId, savings],
    );
    await pool.query(
      `insert into public.category_suggestions
         (transaction_id, budget_id, rank, category_id, confidence, reason, source, status)
       values ($1, $2, 1, $3, 0.9, null, 'jev', 'pending')
       on conflict (transaction_id, rank) do update set category_id = excluded.category_id`,
      [txn, b.budgetId, b.food],
    );
    const { rows } = await pool.query<{ category_id: string | null; transfer_account_id: string | null }>(
      'select category_id, transfer_account_id from public.category_suggestions where transaction_id = $1 and rank = 1',
      [txn],
    );
    expect(rows).toEqual([{ category_id: b.food, transfer_account_id: savings }]);
  });

  test('V8: deleting the account a transfer decision names takes the record with it', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-06', amount: -4200 });
    const savings = await newAccount(b.budgetId, 'Savings');
    await pool.query(
      `insert into public.categorize_decisions (transaction_id, budget_id, kind, transfer_account_id)
       values ($1, $2, 'transfer', $3)`,
      [txn, b.budgetId, savings],
    );
    // A cascade keeps the invariant; "set null" would fail the check instead.
    await pool.query('delete from public.accounts where id = $1', [savings]);
    const { rows } = await pool.query('select 1 from public.categorize_decisions where transaction_id = $1', [txn]);
    expect(rows).toEqual([]);
  });
});
