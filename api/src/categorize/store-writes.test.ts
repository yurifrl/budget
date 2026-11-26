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
import { cleanupFixtures, newBudget, newSuggestion, newTransaction, suggestionsOf, type BudgetFixture } from './testing';

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
  categoryId,
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

    expect(await replaceSuggestions(pool, b.budgetId, txn, [row(b.food)])).toBe(0);
    expect(await suggestionsOf(txn)).toEqual([]);
  });

  test('a category the budget may not use is dropped, and the ranks stay contiguous', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-03', amount: -4000 });
    // The model answered out of a list that went stale: a hidden category first.
    expect(await replaceSuggestions(pool, b.budgetId, txn, [row(b.hidden), row(b.food, 0.6)])).toBe(1);

    const stored = await suggestionsOf(txn);
    expect(stored.map((suggestion) => [suggestion.category_id, suggestion.rank])).toEqual([[b.food, 1]]);
  });

  test('a set already answered by the person is not overwritten', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-04', amount: -3900 });
    await newSuggestion({ transactionId: txn, budgetId: b.budgetId, categoryId: b.food, status: 'accepted' });

    expect(await replaceSuggestions(pool, b.budgetId, txn, [row(b.dining)])).toBe(0);
    expect((await suggestionsOf(txn)).map((suggestion) => suggestion.status)).toEqual(['accepted']);
  });
});
