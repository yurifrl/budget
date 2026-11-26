/**
 * The categorize run against Postgres with a stubbed Jev call: what one run
 * suggests, the one-call-per-transaction facts it sends, and the rules that
 * keep a later run from re-sending rows (attempt cap, changed facts, skipped
 * rows). The run never writes a transaction's category.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { configureSecretBox } from '../core/secret-box';
import { dbReady } from '../core/test-gate';
import {
  JEV_MAX_OPTIONS,
  JEV_MODEL,
  JevFailure,
  saveOwnKey,
  type JevAnswer,
  type JevCall,
  type JevSuggestion,
} from '../jev';
import { CATEGORIZE_RUN_LIMIT } from '@shared/contracts/categorize';

import { enqueueCategorizeRun } from './job';
import {
  MAX_ATTEMPTS_PER_TRANSACTION,
  RUN_CONCURRENCY,
  RunFailure,
  runCategorize,
  TRANSIENT_STREAK_LIMIT,
} from './run';
import { failProgress, markInternalFailure, readProgress, RUN_LIMIT, type RunProgress } from './run-store';
import { runStatus } from './run-status';
import {
  cleanupFixtures,
  newAccount,
  newBudget,
  newCategory,
  newGroup,
  newPayee,
  newSuggestion,
  newTransaction,
  newUser,
  suggestionsOf,
  type BudgetFixture,
} from './testing';

const KEY = 'sk-or-v1-0123456789abcdef';
const jobRuns: string[] = [];

/** A finished `categorize_run` row of the given budget (one per simulated run). */
async function jobRun(budgetId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into jobs.job_runs (job_type, subject_key, instance_id, input, status)
     values ('categorize_run', $1, 'categorize-run-test', $2::jsonb, 'succeeded') returning id`,
    [budgetId, JSON.stringify({ budgetId })],
  );
  jobRuns.push(rows[0]!.id);
  return rows[0]!.id;
}

describe.skipIf(!dbReady)('the categorize run', () => {
  let b: BudgetFixture;
  /** The wire answer of a stubbed call: the suggestions asked for, in the model's voice. */
  const answer = (...suggestions: JevSuggestion[]): JevAnswer => ({ suggestions, model: JEV_MODEL });
  const alwaysFood: (call: JevCall) => Promise<JevAnswer> = async () =>
    answer({ categoryId: b.food, confidence: 0.9 });
  beforeEach(async () => {
    configureSecretBox({ current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) });
    b = await newBudget('run');
    await saveOwnKey(pool, b.userId, KEY);
  });

  afterAll(async () => {
    configureSecretBox(null);
    if (jobRuns.length > 0) await pool.query('delete from jobs.job_runs where id = any($1::uuid[])', [jobRuns.splice(0)]);
    await cleanupFixtures();
  });

  test('suggests for every candidate and never writes a category', async () => {
    const first = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-02', amount: -4200 });
    const second = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-03', amount: -800 });
    const progress = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async () => answer(
        { categoryId: b.food, confidence: 0.9 },
        { categoryId: b.dining, confidence: 0.2 },
      ),
    });

    expect(progress).toEqual({ done: 2, total: 2, failures: 0, failure: null });
    for (const id of [first, second]) {
      const rows = await suggestionsOf(id);
      expect(rows.map((row) => [row.category_id, row.rank, row.source, row.provider])).toEqual([
        [b.food, 1, 'jev', 'jev'],
        [b.dining, 2, 'jev', 'jev'],
      ]);
    }
    const { rows } = await pool.query<{ category_id: string | null }>(
      'select category_id from public.transactions where id = any($1::uuid[])',
      [[first, second]],
    );
    expect(rows.map((row) => row.category_id)).toEqual([null, null]);
  });

  test('sends the payee\'s past categories, the bank text and the memo', async () => {
    const payeeId = await newPayee(b.budgetId, 'Mercado Central');
    await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-10-01',
      amount: -3000,
      payeeId,
      categoryId: b.food,
    });
    await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-04',
      amount: -58900,
      payeeId,
      memo: 'compra da semana',
      rawPayload: { descriptionRaw: 'PIX MERCADO CENTRAL' },
    });

    const sent: JevCall[] = [];
    await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async (call) => {
        sent.push(call);
        return answer({ categoryId: b.food, confidence: 0.94 });
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.facts.payeeHistory).toEqual(['Everyday / Food']);
    expect(sent[0]!.facts.bankText).toBe('PIX MERCADO CENTRAL');
    expect(sent[0]!.facts.memo).toBe('compra da semana');
    expect(sent[0]!.facts.amount).toBe(-58900);
  });

  test('a failed call is one attempt, retried by a later run until the cap', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-05', amount: -1000 });
    const broken = async () => {
      throw new JevFailure('http', 'jev answered 500');
    };

    const first = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, { classify: broken });
    expect(first.failures).toBe(1);
    const { rows } = await pool.query<{ outcome: string; error_kind: string; attempts: number }>(
      'select outcome, error_kind, attempts from public.categorize_attempts where transaction_id = $1',
      [txn],
    );
    expect(rows).toEqual([{ outcome: 'failed', error_kind: 'http', attempts: 1 }]);

    // The next run retries it; a good answer replaces the failed attempt.
    const second = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: alwaysFood,
    });
    expect(second.total).toBe(1);
    expect((await suggestionsOf(txn)).map((row) => row.category_id)).toEqual([b.food]);
    // The good answer resets the count: the cap only counts consecutive
    // row-level failures.
    const after = await pool.query<{ outcome: string; attempts: number }>(
      'select outcome, attempts from public.categorize_attempts where transaction_id = $1',
      [txn],
    );
    expect(after.rows).toEqual([{ outcome: 'suggested', attempts: 0 }]);

    // A row that keeps failing stops being a candidate at the cap.
    const other = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-06', amount: -2000 });
    for (let i = 0; i < MAX_ATTEMPTS_PER_TRANSACTION; i++) {
      await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, { classify: broken });
    }
    const last = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, { classify: alwaysFood });
    expect(last.total).toBe(0);
    expect(await suggestionsOf(other)).toEqual([]);
  });

  test('a refused key or an account out of credit stops the run, with no attempt', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-07', amount: -500 });
    const cases = [
      { kind: 'rejected_key', reason: 'key_rejected' },
      { kind: 'no_credits', reason: 'no_credits' },
    ] as const;
    for (const { kind, reason } of cases) {
      const runId = await jobRun(b.budgetId);
      const failed = await runCategorize(pool, { runId, budgetId: b.budgetId }, {
        classify: async () => {
          throw new JevFailure(kind, `jev said ${kind}`);
        },
      }).catch((err: unknown) => err);
      expect(failed).toBeInstanceOf(RunFailure);
      expect((failed as RunFailure).reason).toBe(reason);
      const { rows } = await pool.query('select 1 from public.categorize_attempts where transaction_id = $1', [txn]);
      expect(rows).toEqual([]);
      const progress = await pool.query<{ failure: string | null }>(
        'select failure from public.categorize_run_progress where run_id = $1',
        [runId],
      );
      expect(progress.rows[0]!.failure).toBe(reason);
    }
  });

  test('unchanged facts are not re-sent; a changed memo, amount or bank text is', async () => {
    const txn = await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-08',
      amount: -900,
      rawPayload: { descriptionRaw: 'PIX MERCADO' },
    });
    const first = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: alwaysFood,
    });
    expect(first.total).toBe(1);

    const again = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: alwaysFood,
    });
    expect(again.total).toBe(0);

    await pool.query('update public.transactions set memo = $2 where id = $1', [txn, 'a different memo']);
    const changedMemo = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async () => answer({ categoryId: b.dining, confidence: 0.8 }),
    });
    expect(changedMemo.total).toBe(1);
    expect((await suggestionsOf(txn)).map((row) => row.category_id)).toEqual([b.dining]);

    await pool.query('update public.transactions set amount = $2 where id = $1', [txn, -1500]);
    const changedAmount = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: alwaysFood,
    });
    expect(changedAmount.total).toBe(1);

    await pool.query(
      `update public.connection_transactions set bank_text = 'PIX OUTRA LOJA'
        where transaction_id = $1 and budget_id = $2`,
      [txn, b.budgetId],
    );
    const changedBankText = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: alwaysFood,
    });
    expect(changedBankText.total).toBe(1);
    expect((await suggestionsOf(txn)).map((row) => row.category_id)).toEqual([b.food]);
  });

  test('a pending suggestion with no fingerprint is neither sent again nor replaced', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-10', amount: -1500 });
    await newSuggestion({ transactionId: txn, budgetId: b.budgetId, categoryId: b.food, confidence: 0.7, reason: 'earlier' });
    // Rows written before 0126 (or by another source) carry no fingerprint.
    await pool.query('update public.category_suggestions set input_fingerprint = null where transaction_id = $1', [txn]);

    let asked = 0;
    const run = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async () => {
        asked += 1;
        return answer({ categoryId: b.dining, confidence: 0.9 });
      },
    });
    expect(asked).toBe(0);
    expect(run.total).toBe(0);
    expect((await suggestionsOf(txn)).map((row) => [row.category_id, row.confidence, row.reason])).toEqual([
      [b.food, 0.7, 'earlier'],
    ]);
  });

  test('a no-suggestion attempt on the same facts blocks a re-ask', async () => {
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-11', amount: -1100 });
    const first = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async () => answer(),
    });
    expect(first.total).toBe(1);

    let asked = 0;
    const again = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async () => {
        asked += 1;
        return answer({ categoryId: b.food, confidence: 0.9 });
      },
    });
    expect(asked).toBe(0);
    expect(again.total).toBe(0);
  });

  test('a decided or skipped transaction is never sent', async () => {
    const skipped = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-09', amount: -700 });
    await newSuggestion({ transactionId: skipped, budgetId: b.budgetId, categoryId: b.food });
    await pool.query(
      `insert into public.categorize_decisions (budget_id, transaction_id, kind)
       values ($1, $2, 'skip')`,
      [b.budgetId, skipped],
    );
    const decided = await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-10',
      amount: -300,
      categoryId: b.food,
    });
    await pool.query(
      `insert into public.categorize_decisions (budget_id, transaction_id, kind, category_id)
       values ($1, $2, 'accept', $3)`,
      [b.budgetId, decided, b.food],
    );

    const progress = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: alwaysFood,
    });
    expect(progress.total).toBe(0);
  });

  test('a budget with more categories than Jev accepts stops, and the run records why', async () => {
    const groupId = await newGroup(b.budgetId, 'Bulk');
    for (let i = 0; i < JEV_MAX_OPTIONS; i++) {
      await newCategory(b.budgetId, groupId, `Bulk ${i}`);
    }
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-11', amount: -100 });
    const runId = await jobRun(b.budgetId);
    await expect(
      runCategorize(pool, { runId, budgetId: b.budgetId }, { classify: alwaysFood }),
    ).rejects.toThrow(String(JEV_MAX_OPTIONS));
    // The row did not exist when it stopped: the code is written anyway (S3).
    const { rows } = await pool.query<RunProgress>(
      'select done, total, failures, failure from public.categorize_run_progress where run_id = $1',
      [runId],
    );
    expect(rows).toEqual([{ done: 0, total: 0, failures: 0, failure: 'too_many_categories' }]);
  });

  test("a shared budget uses the budget OWNER's key, never a member's", async () => {
    const member = await newUser('run-member');
    await saveOwnKey(pool, member, 'sk-or-v1-memberkey0123456789');
    await pool.query('insert into public.budget_members (budget_id, user_id) values ($1, $2)', [b.budgetId, member]);
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-12', amount: -500 });

    const seen: string[] = [];
    await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async (call) => {
        seen.push(call.key);
        return answer({ categoryId: b.food, confidence: 0.9 });
      },
    });
    expect(seen).toEqual([KEY]);
  });

  test('progress is readable while it runs, and a redelivered run never restarts it', async () => {
    const first = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-13', amount: -600 });
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-14', amount: -700 });

    // The progress row exists before the first answer is written, so a poll
    // mid-run already sees the total this run will work through.
    const midway: { done: number; total: number }[] = [];
    const runFor = (runId: string) =>
      runCategorize(pool, { runId, budgetId: b.budgetId }, {
        classify: async () => {
          const { rows } = await pool.query<{ done: number; total: number }>(
            'select done, total from public.categorize_run_progress where run_id = $1',
            [runId],
          );
          midway.push(rows[0]!);
          return answer({ categoryId: b.food, confidence: 0.9 });
        },
      });

    const runId = await jobRun(b.budgetId);
    const progress = await runFor(runId);
    expect(midway[0]).toEqual({ done: 0, total: 2 });
    expect(progress).toMatchObject({ done: 2, total: 2, failures: 0 });

    // Temporal may redeliver the activity under the same run id: no row is
    // asked twice and the progress shown is neither reset nor shrunk.
    const again = await runFor(runId);
    expect(midway).toHaveLength(2);
    expect(again).toMatchObject({ done: 2, total: 2 });
    expect(await suggestionsOf(first)).toHaveLength(1);
  });

  test('a row Jev could not answer is asked once per run and never spends its cap', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-16', amount: -800 });
    const runId = await jobRun(b.budgetId);
    let calls = 0;
    const busy = await runCategorize(pool, { runId, budgetId: b.budgetId }, {
      classify: async () => {
        calls++;
        throw new JevFailure('rate_limited', 'jev is busy');
      },
    });
    expect(calls).toBe(1);
    // Jev never judged the row: it is counted as unanswered (the page says so)
    // but spends no attempt.
    expect(busy).toMatchObject({ done: 0, total: 1, failures: 1 });

    const attempts = async () =>
      (
        await pool.query<{ outcome: string; attempts: number }>(
          'select outcome, attempts from public.categorize_attempts where transaction_id = $1',
          [txn],
        )
      ).rows;
    expect(await attempts()).toEqual([{ outcome: 'failed', attempts: 0 }]);

    // The same run id (a Temporal retry of the activity): the row was already
    // attempted by this run, so it is not asked twice inside it.
    const again = await runCategorize(pool, { runId, budgetId: b.budgetId }, { classify: alwaysFood });
    expect(calls).toBe(1);
    expect(again).toMatchObject({ done: 0, total: 1 });

    // A later run asks it again, and the transient answer cost it no attempt.
    const later = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, { classify: alwaysFood });
    expect(later.total).toBe(1);
    expect((await suggestionsOf(txn)).map((row) => row.category_id)).toEqual([b.food]);
  });

  test('a few rows are in flight at once, so one slow call does not hold the queue', async () => {
    for (let i = 0; i < RUN_CONCURRENCY + 1; i++) {
      await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-17', amount: -300 - i });
    }
    // Every call hangs until RUN_CONCURRENCY of them are open: only a run that
    // really asks several rows at once gets past this, and no clock is involved.
    const gate = Promise.withResolvers<void>();
    let inFlight = 0;
    let peak = 0;
    const progress = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        if (inFlight === RUN_CONCURRENCY) gate.resolve();
        await gate.promise;
        inFlight--;
        return answer({ categoryId: b.food, confidence: 0.8 });
      },
    });
    expect(peak).toBe(RUN_CONCURRENCY);
    expect(progress).toMatchObject({ done: RUN_CONCURRENCY + 1, total: RUN_CONCURRENCY + 1, failures: 0 });
  });

  test('the run has no date window: a row from years ago is asked like any other', async () => {
    const old = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2024-01-05', amount: -1234 });
    const run = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: alwaysFood,
    });
    expect(run).toMatchObject({ done: 1, total: 1, failures: 0 });
    expect((await suggestionsOf(old)).map((row) => row.category_id)).toEqual([b.food]);
  });

  test('"Jev unavailable" answers in a row stop the run with that reason', async () => {
    for (let i = 0; i < TRANSIENT_STREAK_LIMIT; i++) {
      await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-19', amount: -900 - i });
    }
    const runId = await jobRun(b.budgetId);
    const failed = await runCategorize(pool, { runId, budgetId: b.budgetId }, {
      classify: async () => {
        throw new JevFailure('server', 'jev answered 503');
      },
    }).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(RunFailure);
    expect((failed as RunFailure).reason).toBe('jev_unavailable');
    const { rows } = await pool.query<{ failure: string }>(
      'select failure from public.categorize_run_progress where run_id = $1',
      [runId],
    );
    expect(rows[0]!.failure).toBe('jev_unavailable');
  });

  test("the payee's history leaves out deleted rows and visible-category rules", async () => {
    const payee = await newPayee(b.budgetId, 'Mercado Central');
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-09-01', amount: -1000, payeeId: payee, categoryId: b.food });
    const gone = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-09-02', amount: -2000, payeeId: payee, categoryId: b.dining });
    await pool.query('update public.transactions set deleted = true where id = $1', [gone]);
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-09-03', amount: -3000, payeeId: payee, categoryId: b.hidden });
    // The run only asks about a row that still needs a category: this one.
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-21', amount: -4500, payeeId: payee });

    const history: string[][] = [];
    await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async (call) => {
        history.push(call.facts.payeeHistory);
        return answer({ categoryId: b.food, confidence: 0.8 });
      },
    });
    expect(history).toEqual([['Everyday / Food']]);
  });

  test('a changed bank text or account is a changed fact; the memo alone already was', async () => {
    const payee = await newPayee(b.budgetId, 'Padaria do Ze');
    const txn = await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-20',
      amount: -1700,
      payeeId: payee,
      rawPayload: { descriptionRaw: 'PADARIA' },
    });
    const runWith = async (classify: (call: JevCall) => Promise<JevAnswer>) =>
      runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, { classify });

    await runWith(async () => answer({ categoryId: b.food, confidence: 0.9 }));
    let calls = 0;
    const unchanged = await runWith(async () => {
      calls++;
      return answer({ categoryId: b.dining, confidence: 0.5 });
    });
    expect(calls).toBe(0);
    expect(unchanged.total).toBe(0);

    await pool.query(`update public.connection_transactions set bank_text = 'PIX PADARIA DO ZE' where transaction_id = $1`, [txn]);
    const afterText = await runWith(async () => answer({ categoryId: b.dining, confidence: 0.8 }));
    expect(afterText.total).toBe(1);
    expect((await suggestionsOf(txn)).map((row) => row.category_id)).toEqual([b.dining]);

    const otherAccount = await newAccount(b.budgetId, 'Cartao');
    await pool.query('update public.transactions set account_id = $2 where id = $1', [txn, otherAccount]);
    const afterAccount = await runWith(async () => answer({ categoryId: b.food, confidence: 0.7 }));
    expect(afterAccount.total).toBe(1);
    expect((await suggestionsOf(txn)).map((row) => row.category_id)).toEqual([b.food]);
  });

  test('an answer naming a category the budget may not use becomes "no suggestion"', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-21', amount: -2600 });
    const run = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async () => answer({ categoryId: b.hidden, confidence: 0.99 }),
    });
    expect(run).toMatchObject({ done: 1, total: 1, failures: 0 });
    expect(await suggestionsOf(txn)).toEqual([]);
    const { rows } = await pool.query<{ outcome: string }>(
      'select outcome from public.categorize_attempts where transaction_id = $1',
      [txn],
    );
    expect(rows[0]!.outcome).toBe('no_suggestion');
  });

  test('one run per budget at a time: a second start joins the running one', async () => {
    const first = await enqueueCategorizeRun(pool, b.budgetId, b.userId);
    const second = await enqueueCategorizeRun(pool, b.budgetId, b.userId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    jobRuns.push(first.run.id);
  });


  test('a redelivered run keeps its own size: it asks only what the total leaves, and done never passes it', async () => {
    for (let i = 0; i < RUN_LIMIT + 2; i++) {
      await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-01', amount: -100 - i });
    }
    const runId = await jobRun(b.budgetId);
    let calls = 0;
    // Second call crashes the activity: the first delivery leaves a frozen
    // total with a few rows answered, and plenty of rows still available.
    const crashed = await runCategorize(pool, { runId, budgetId: b.budgetId }, {
      classify: async () => {
        calls += 1;
        if (calls === 2) throw new Error('database exploded');
        return answer({ categoryId: b.food, confidence: 0.9 });
      },
    }).catch((err: unknown) => err);
    expect(crashed).toBeInstanceOf(Error);
    const first = await pool.query<RunProgress>(
      'select done, total, failures, failure from public.categorize_run_progress where run_id = $1',
      [runId],
    );
    expect(first.rows[0]!.total).toBe(CATEGORIZE_RUN_LIMIT);

    // Redelivery: the same run, the same frozen total.
    const again = await runCategorize(pool, { runId, budgetId: b.budgetId }, { classify: alwaysFood });
    expect(again.total).toBe(CATEGORIZE_RUN_LIMIT);
    expect(again.done).toBe(CATEGORIZE_RUN_LIMIT);
    const asked = await pool.query<{ n: number }>(
      'select count(*)::int as n from public.categorize_attempts where last_run_id = $1',
      [runId],
    );
    expect(asked.rows[0]!.n).toBeLessThanOrEqual(CATEGORIZE_RUN_LIMIT);
  });

  test('a success resets the attempt count; only row-level failures climb it', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-02', amount: -800 });
    const attempts = async () => {
      const { rows } = await pool.query<{ attempts: number }>(
        'select attempts from public.categorize_attempts where transaction_id = $1',
        [txn],
      );
      return rows[0]?.attempts;
    };
    const failing = async () => {
      throw new JevFailure('http', 'jev answered 500');
    };

    await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, { classify: alwaysFood });
    expect(await attempts()).toBe(0);

    // The facts change, so the row is a question again: two unusable answers
    // in a row count 1 then 2.
    await pool.query('update public.transactions set memo = $2 where id = $1', [txn, 'a different memo']);
    await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, { classify: failing }).catch(
      () => undefined,
    );
    expect(await attempts()).toBe(1);
    await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, { classify: failing }).catch(
      () => undefined,
    );
    expect(await attempts()).toBe(2);

    // An answer, even an empty one, is not a failure.
    await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async () => answer(),
    });
    expect(await attempts()).toBe(0);
  });

  test('a crash waits for the calls already in flight before the activity fails', async () => {
    for (let i = 0; i < RUN_CONCURRENCY; i++) {
      await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-03', amount: -200 - i });
    }
    const boom = new Error('database exploded');
    let inFlight = 0;
    const crashed = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async () => {
        inFlight += 1;
        try {
          await Bun.sleep(10);
          throw boom;
        } finally {
          inFlight -= 1;
        }
      },
    }).catch((err: unknown) => err);
    expect(crashed).toBe(boom);
    // Nothing is still running: a retry cannot overlap the previous answers.
    expect(inFlight).toBe(0);
  });

  test('a crash that ends the run leaves the internal code behind, never over a named one', async () => {
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-04', amount: -600 });
    const runId = await jobRun(b.budgetId);
    await runCategorize(pool, { runId, budgetId: b.budgetId }, { classify: alwaysFood });
    await markInternalFailure(pool, runId, b.budgetId);
    const { rows } = await pool.query<{ failure: string | null }>(
      'select failure from public.categorize_run_progress where run_id = $1',
      [runId],
    );
    expect(rows[0]!.failure).toBe('internal');

    await pool.query(`update public.categorize_run_progress set failure = 'key_rejected' where run_id = $1`, [runId]);
    await markInternalFailure(pool, runId, b.budgetId);
    const after = await pool.query<{ failure: string | null }>(
      'select failure from public.categorize_run_progress where run_id = $1',
      [runId],
    );
    expect(after.rows[0]!.failure).toBe('key_rejected');
  });

  test('the model that answered is stored on the suggestion and on the attempt', async () => {
    const txn = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-05', amount: -700 });
    await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async () => ({ suggestions: [{ categoryId: b.food, confidence: 0.9 }], model: 'typesafe/jev-1.13-20260917' }),
    });
    const suggestion = await pool.query<{ model: string }>(
      'select model from public.category_suggestions where transaction_id = $1',
      [txn],
    );
    expect(suggestion.rows[0]!.model).toBe('typesafe/jev-1.13-20260917');
    const attempt = await pool.query<{ model: string }>(
      'select model from public.categorize_attempts where transaction_id = $1',
      [txn],
    );
    expect(attempt.rows[0]!.model).toBe('typesafe/jev-1.13-20260917');
  });

  test('status says not configured with no_owner for a budget nobody owns', async () => {
    const ownerless = crypto.randomUUID();
    await pool.query('insert into public.budgets (id, name, owner_user_id) values ($1, $2, null)', [ownerless, 'ownerless']);
    try {
      expect(await runStatus(pool, ownerless)).toMatchObject({
        configured: false,
        reason: 'no_owner',
        run: null,
      });
    } finally {
      await pool.query('delete from public.budgets where id = $1', [ownerless]);
    }
  });

  test('across deliveries a run asks no more distinct rows than its total, even with transient answers', async () => {
    // 150 rows against a run limit of 100, every second call rate limited and a
    // crash on the 51st: a transient answer stamps its row but adds nothing to
    // `done`, so sizing the redelivery by `done` asks 75 more rows and the run
    // asks 125 distinct rows for a total of 100.
    for (let i = 0; i < 150; i++) {
      await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-20', amount: -100 - i });
    }
    const runId = await jobRun(b.budgetId);
    const asked: number[] = [];
    let calls = 0;
    const classify = async (call: JevCall): Promise<JevAnswer> => {
      calls += 1;
      asked.push(call.facts.amount);
      if (calls === 51) throw new Error('worker died mid-run');
      if (calls % 2 === 0) throw new JevFailure('rate_limited', 'slow down');
      return answer({ categoryId: b.food, confidence: 0.9 });
    };

    const first = await runCategorize(pool, { runId, budgetId: b.budgetId }, { classify }).catch((err: unknown) => err);
    expect(first).toBeInstanceOf(Error);
    const second = await runCategorize(pool, { runId, budgetId: b.budgetId }, { classify });

    expect(second.total).toBe(RUN_LIMIT);
    expect(new Set(asked).size).toBe(RUN_LIMIT);
    expect(second.done).toBeLessThanOrEqual(second.total);
  });

  test('a row the person categorized mid-run still counts as asked by this run, so a redelivery stays within the total', async () => {
    for (let i = 0; i < 150; i++) {
      await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-20', amount: -100 - i });
    }
    const runId = await jobRun(b.budgetId);
    const asked: number[] = [];
    let calls = 0;
    const classify = async (call: JevCall): Promise<JevAnswer> => {
      calls += 1;
      asked.push(call.facts.amount);
      if (calls === 51) throw new Error('worker died mid-run');
      if (calls <= 5) {
        // The person settles the row while the run is still asking about it.
        await pool.query(
          'update public.transactions set category_id = $2 where budget_id = $1 and amount = $3',
          [b.budgetId, b.food, call.facts.amount],
        );
      }
      return answer({ categoryId: b.food, confidence: 0.9 });
    };

    const first = await runCategorize(pool, { runId, budgetId: b.budgetId }, { classify }).catch((err: unknown) => err);
    expect(first).toBeInstanceOf(Error);
    await runCategorize(pool, { runId, budgetId: b.budgetId }, { classify });

    expect(new Set(asked).size).toBe(RUN_LIMIT);
    const { rows } = await pool.query(
      'select 1 from public.category_suggestions where budget_id = $1 and transaction_id in (select id from public.transactions where budget_id = $1 and category_id is not null)',
      [b.budgetId],
    );
    expect(rows).toHaveLength(0);
  });

  test('any worker rejection stops new calls from starting', async () => {
    for (let i = 0; i < 40; i++) {
      await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-21', amount: -100 - i });
    }
    const runId = await jobRun(b.budgetId);
    // The third progress write rejects once (a dropped connection, say).
    let bumps = 0;
    const flaky = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop !== 'query') return Reflect.get(target, prop, receiver);
        return (text: unknown, ...rest: unknown[]) => {
          if (typeof text === 'string' && text.includes('update public.categorize_run_progress') && ++bumps === 3) {
            return Promise.reject(new Error('connection dropped'));
          }
          return (target.query as (...args: unknown[]) => unknown)(text, ...rest);
        };
      },
    });
    let calls = 0;
    const crashed = await runCategorize(flaky, { runId, budgetId: b.budgetId }, {
      classify: async () => {
        calls += 1;
        throw new JevFailure('http', 'jev answered 500');
      },
    }).catch((err: unknown) => err);
    expect(crashed).toBeInstanceOf(Error);
    expect((crashed as Error).message).toBe('connection dropped');
    expect(calls).toBeLessThanOrEqual(3 + RUN_CONCURRENCY);
  });

  test('a named stop is recorded even when a worker rejected in the same delivery', async () => {
    for (let i = 0; i < 4; i++) {
      await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-22', amount: -100 - i });
    }
    const runId = await jobRun(b.budgetId);
    await pool.query(
      `insert into public.categorize_run_progress (run_id, budget_id, done, total, failures, failure)
       values ($1, $2, 0, 4, 2147483647, null)`,
      [runId, b.budgetId],
    );
    let calls = 0;
    const crashed = await runCategorize(pool, { runId, budgetId: b.budgetId }, {
      classify: async () => {
        calls += 1;
        // One row fails unusably (its progress bump overflows), the rest hit a refused key.
        throw calls === 1 ? new JevFailure('http', 'jev answered 500') : new JevFailure('rejected_key', 'jev answered 401');
      },
    }).catch((err: unknown) => err);
    expect(crashed).toBeInstanceOf(Error);
    expect((await readProgress(pool, runId))!.failure).toBe('key_rejected');
  });

  test('a row that hit the attempt cap comes back when its facts change', async () => {
    const txn = await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-09',
      amount: -1200,
      memo: 'first memo',
    });
    const broken = async () => {
      throw new JevFailure('http', 'jev answered 500');
    };
    for (let i = 0; i < MAX_ATTEMPTS_PER_TRANSACTION; i++) {
      await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, { classify: broken });
    }
    const capped = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, { classify: alwaysFood });
    expect(capped.total).toBe(0);

    // The cap counts the failures of the facts the row still carries: a new
    // memo is a new question, so the row is asked again instead of staying
    // lost for good.
    await pool.query('update public.transactions set memo = $2 where id = $1', [txn, 'second memo']);
    const changed = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, { classify: alwaysFood });
    expect(changed.total).toBe(1);
    const { rows } = await pool.query<{ outcome: string; attempts: number }>(
      'select outcome, attempts from public.categorize_attempts where transaction_id = $1',
      [txn],
    );
    expect(rows).toEqual([{ outcome: 'suggested', attempts: 0 }]);
  });

  test('a progress write that throws fails the run instead of closing it as a finished one', async () => {
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-13', amount: -1600 });
    const runId = await jobRun(b.budgetId);
    // A progress row that cannot take another failure (integer overflow): the
    // write in the worker's `finally` rejects, so the run must not resolve with
    // a partial count as if it had finished.
    await pool.query(
      `insert into public.categorize_run_progress (run_id, budget_id, done, total, failures, failure)
       values ($1, $2, 0, 1, 2147483647, null)`,
      [runId, b.budgetId],
    );
    const crashed = await runCategorize(pool, { runId, budgetId: b.budgetId }, {
      classify: async () => {
        throw new JevFailure('http', 'jev answered 500');
      },
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(crashed).toBeInstanceOf(Error);
    expect(crashed).not.toBeInstanceOf(RunFailure);
    expect((crashed as Error).message).toMatch(/out of range/i);
    expect((await readProgress(pool, runId))!.failure).toBeNull();
  });

  test('a stop message is our own sentence, never the remote body', async () => {
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-12', amount: -1400 });
    const remote = 'jev answered 401: {"error":{"message":"Incorrect API key sk-or-v1-deadbeef"}}';
    const stopped = await runCategorize(pool, { runId: await jobRun(b.budgetId), budgetId: b.budgetId }, {
      classify: async () => {
        throw new JevFailure('rejected_key', remote);
      },
    }).catch((err: unknown) => err);
    expect(stopped).toBeInstanceOf(RunFailure);
    const failure = stopped as RunFailure;
    expect(failure.reason).toBe('key_rejected');
    expect(failure.message).not.toContain('sk-or-v1-deadbeef');
    expect(failure.message).not.toContain('401');
    expect(failure.message).toBe('Jev refused this budget\u2019s key.');
  });

  test('a progress write cannot land on another budget\u2019s run and cannot replace the first failure code', async () => {
    const other = await newBudget('other-run');
    const runId = await jobRun(b.budgetId);

    // Another budget's id: neither creates the row nor touches an existing one.
    await failProgress(pool, runId, other.budgetId, 'key_rejected');
    expect(await readProgress(pool, runId)).toBeNull();

    await failProgress(pool, runId, b.budgetId, 'no_credits');
    expect((await readProgress(pool, runId))!.failure).toBe('no_credits');

    // The first code sticks: a crash or a later stop never buries the reason
    // the person can act on.
    await markInternalFailure(pool, runId, b.budgetId);
    expect((await readProgress(pool, runId))!.failure).toBe('no_credits');
    await failProgress(pool, runId, b.budgetId, 'jev_unavailable');
    expect((await readProgress(pool, runId))!.failure).toBe('no_credits');
    await failProgress(pool, runId, other.budgetId, 'key_rejected');
    expect((await readProgress(pool, runId))!.failure).toBe('no_credits');
  });
});
