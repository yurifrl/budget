/**
 * SQL for the categorize RUN: which transactions a run may ask about, the facts
 * one call carries, and the run's progress row. Every statement is scoped by
 * `budget_id` in SQL; nothing here writes a transaction's category.
 *
 * Candidate rule: the shared "needs a category" predicate
 * (`shared/src/domain/category-needs.ts`) split in two, so a test can run the
 * SQL base and the oracle over the same fixtures and compare the sets:
 *  1. `RUN_CANDIDATE_WHERE` — one side of the oracle: live rows after the
 *     inflow/transfer/split/off-budget/transfer-payee facts, plus the transfer
 *     plan's pending ids;
 *  2. the run's own bookkeeping — rows the owner decided or skipped, rows
 *     already answered from the facts they still have (fingerprint), rows at
 *     the attempt cap, and rows a previous run just failed. None of those are
 *     "needs a category" facts, so the oracle says nothing about them.
 */
import type { CategorizeRunFailure } from '@shared/contracts/categorize';

import { CATEGORIZE_RUN_LIMIT } from '@shared/contracts/categorize';

import type { Queryable } from '../core/db';

import { ATTEMPT_FINGERPRINT, BANK_FACTS_JOIN, NEEDS_CATEGORY_FROM, NEEDS_CATEGORY_WHERE } from './store';
import { CATEGORIZE_RUN_JOB } from './job';

/** How many transactions one run asks about (the contract owns the number). */
export const RUN_LIMIT = CATEGORIZE_RUN_LIMIT;

export type RunCandidate = {
  transaction_id: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Signed integer milliunits; an outflow is negative. */
  amount: number;
  payee_id: string | null;
  payee: string | null;
  account_name: string;
  account_id: string;
  memo: string | null;
  /** The bank's own text for the row (`connection_transactions.bank_text`). */
  bank_text: string | null;
  raw_payload: Record<string, unknown> | null;
};

/**
 * The run's half of the candidate rule. Args: $1 budget, $2 pending transfer
 * ids, $3 max attempts per transaction, $4 the run that is asking.
 *
 * A row is skipped when (a) a person decided or skipped it, (b) it already has
 * pending suggestions made from the facts it still carries, (c) its last
 * answer was "no suggestion" for those same facts, (d) its recorded failures
 * reached the cap **for the facts it still carries**, or (e) THIS run already
 * touched it — so a redelivered run never asks again about a row it answered,
 * nor about the one it was holding when the worker died. (d) needs the facts
 * too: a row that failed out and then changed is new information, and skipping
 * it forever would bury it.
 */
export const RUN_SKIP_WHERE = `
    and not exists (
      select 1 from public.categorize_decisions d
       where d.transaction_id = t.id and d.budget_id = t.budget_id
    )
    and not exists (
      select 1 from public.category_suggestions s
       where s.transaction_id = t.id and s.budget_id = t.budget_id
         and s.status = 'pending'
         -- A row written before 0126 (or by another source) has no
         -- fingerprint: unknown facts count as unchanged, never as a reason
         -- to ask again and replace an answer the person may already see.
         and (s.input_fingerprint is null or s.input_fingerprint = ${ATTEMPT_FINGERPRINT})
    )
    and not exists (
      select 1 from public.categorize_attempts ca
       where ca.transaction_id = t.id and ca.budget_id = t.budget_id
        and (
          (
            ca.outcome = 'no_suggestion'
            and (ca.input_fingerprint is null or ca.input_fingerprint = ${ATTEMPT_FINGERPRINT})
          )
          or (
            ca.outcome = 'failed'
            and ca.attempts >= $3
            and (ca.input_fingerprint is null or ca.input_fingerprint = ${ATTEMPT_FINGERPRINT})
          )
          or ca.last_run_id = $4::uuid
        )
    )`;

/**
 * The rows this run may send. Args: $1 budget, $2 pending transfer ids,
 * $3 max attempts per transaction, $4 the run id.
 */
export async function runCandidates(
  db: Queryable,
  budgetId: string,
  transferIds: string[],
  maxAttempts: number,
  runId: string,
  limit: number,
): Promise<RunCandidate[]> {
  const { rows } = await db.query<RunCandidate>(
    `select t.id as transaction_id, t.date::text as date, t.amount,
            t.payee_id, coalesce(p.name, t.import_payee_name) as payee,
            a.name as account_name, t.account_id, t.memo,
            ct.bank_text, ct.raw_payload
       ${NEEDS_CATEGORY_FROM}
       ${BANK_FACTS_JOIN}
      ${NEEDS_CATEGORY_WHERE}
      ${RUN_SKIP_WHERE}
      order by t.date desc, t.id
      limit $5`,
    [budgetId, transferIds, maxAttempts, runId, limit],
  );
  return rows;
}

/**
 * How many rows a run started NOW would ask about, capped at the limit. Same
 * rule as runCandidates with the run id left null: no attempt carries a null
 * last_run_id, so only the other predicates apply — exactly what a fresh run
 * would take. Feeds the confirmation, the empty state and the disabled button.
 */
export async function candidateCount(
  db: Queryable,
  budgetId: string,
  transferIds: string[],
  maxAttempts: number,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n
       from (
         select t.id
           ${NEEDS_CATEGORY_FROM}
          ${BANK_FACTS_JOIN}
          ${NEEDS_CATEGORY_WHERE}
           ${RUN_SKIP_WHERE}
          limit ${RUN_LIMIT}
       ) rows`,
    [budgetId, transferIds, maxAttempts, null],
  );
  return rows[0]?.n ?? 0;
}

export type CategoryOption = { id: string; label: string };

/** The categories a suggestion may name, in the page's own order. */
export async function assignableCategories(db: Queryable, budgetId: string, limit: number): Promise<CategoryOption[]> {
  const { rows } = await db.query<CategoryOption>(
    `select c.id, g.name || ' / ' || c.name as label
       from public.categories c
       join public.category_groups g on g.id = c.group_id and g.budget_id = c.budget_id
      where c.budget_id = $1
        and c.deleted = false and c.hidden = false and c.internal = false
        and g.deleted = false and g.hidden = false
        and g.is_credit_card_payments = false and g.internal = false
      order by g.sort_order, c.sort_order, c.name
      limit $2`,
    [budgetId, limit],
  );
  return rows;
}

/**
 * `Group / Category` labels this payee was categorized as before, newest first.
 * Deleted transactions and categories the owner hid or deleted are not history
 * worth repeating: they would teach Jev categories the page no longer offers.
 */
export async function payeeHistory(db: Queryable, budgetId: string, payeeId: string, limit: number): Promise<string[]> {
  const { rows } = await db.query<{ label: string }>(
    `select g.name || ' / ' || c.name as label
       from public.transactions t
       join public.categories c on c.id = t.category_id and c.budget_id = t.budget_id
       join public.category_groups g on g.id = c.group_id and g.budget_id = t.budget_id
      where t.budget_id = $1 and t.payee_id = $2 and t.deleted = false
        and c.deleted = false and c.hidden = false and c.internal = false
        and g.deleted = false and g.hidden = false
        and g.is_credit_card_payments = false and g.internal = false
      group by g.name, c.name
      order by max(t.date) desc
      limit $3`,
    [budgetId, payeeId, limit],
  );
  return rows.map((row) => row.label);
}

export type RunProgress = { done: number; total: number; failures: number; failure: CategorizeRunFailure | null };

/**
 * Create the run's progress row up front, so the page reads 0/total while it
 * runs. Created ONCE per run: a Temporal redelivery of the activity must
 * neither reset a count the page already shows nor shrink the run's total.
 */
export async function startProgress(db: Queryable, runId: string, budgetId: string, total: number): Promise<void> {
  await db.query(
    `insert into public.categorize_run_progress (run_id, budget_id, done, total, failures, failure)
     values ($1, $2, 0, $3, 0, null)
     on conflict (run_id) do nothing`,
    [runId, budgetId, total],
  );
}

/**
 * Advance the row by what one finished row did. Increments, never assignments:
 * a redelivered run adds on top of what the page already shows instead of
 * rewinding it, and `total` is never rewritten.
 */
export async function bumpProgress(
  db: Queryable,
  runId: string,
  step: { done: number; failures: number },
): Promise<void> {
  await db.query(
    `update public.categorize_run_progress
        set done = least(total, done + $2), failures = failures + $3, updated_at = now()
      where run_id = $1`,
    [runId, step.done, step.failures],
  );
}

/**
 * The run→budget link every progress write must match: a categorize run IS a
 * row of the jobs ledger whose subject is its budget (`runSubjectKey`), so a
 * call carrying another budget's id can neither create nor overwrite a row
 * under it. Args: $1 run, $2 budget.
 */
const RUN_IS_THIS_BUDGET = `exists (
      select 1 from jobs.job_runs r
      where r.id = $1 and r.job_type = '${CATEGORIZE_RUN_JOB}' and r.subject_key = ($2::uuid)::text
    )`;

/**
 * Why this run stopped, written before the activity fails so the page can
 * explain a failed run instead of showing one generic "failed". Upsert: a run
 * that stops before its first row (no key, no categories) has no progress row
 * yet, and "it never wrote a row" must not read as "it failed for no reason".
 *
 * The first code wins: a crash after a named stop must not bury the reason the
 * person can act on.
 */
export async function failProgress(
  db: Queryable,
  runId: string,
  budgetId: string,
  failure: CategorizeRunFailure,
): Promise<void> {
  await db.query(
    `insert into public.categorize_run_progress (run_id, budget_id, done, total, failures, failure)
     select $1, $2, 0, 0, 0, $3
      where ${RUN_IS_THIS_BUDGET}
     on conflict (run_id) do update
        set failure = coalesce(public.categorize_run_progress.failure, excluded.failure), updated_at = now()
      where public.categorize_run_progress.budget_id = excluded.budget_id`,
    [runId, budgetId, failure],
  );
}

/**
 * The code for a run that ended without naming a reason (a crash that used up
 * its retries). Never overwrites a code the run itself wrote.
 */
export async function markInternalFailure(db: Queryable, runId: string, budgetId: string): Promise<void> {
  await db.query(
    `insert into public.categorize_run_progress (run_id, budget_id, done, total, failures, failure)
     select $1, $2, 0, 0, 0, 'internal'
      where ${RUN_IS_THIS_BUDGET}
     on conflict (run_id) do update
        set failure = coalesce(public.categorize_run_progress.failure, 'internal'), updated_at = now()
      where public.categorize_run_progress.budget_id = excluded.budget_id`,
    [runId, budgetId],
  );
}

/** The progress of one run; null when the run never wrote it. */
export async function readProgress(db: Queryable, runId: string): Promise<RunProgress | null> {
  const { rows } = await db.query<RunProgress>(
    'select done, total, failures, failure from public.categorize_run_progress where run_id = $1',
    [runId],
  );
  return rows[0] ?? null;
}

/**
 * How many DISTINCT rows this run has already touched: a row it answered, a row
 * that came back unusable and a row it was holding when the worker died all
 * carry its id. `done` counts answers only, so sizing the rest of a redelivery
 * by `done` would ask about more rows than `total` names.
 */
export async function runTouched(db: Queryable, runId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'select count(*)::int as n from public.categorize_attempts where last_run_id = $1',
    [runId],
  );
  return rows[0]?.n ?? 0;
}

/** The owner of a budget: the person whose Jev key a run uses. */
export async function budgetOwnerId(db: Queryable, budgetId: string): Promise<string | null> {
  const { rows } = await db.query<{ owner_user_id: string | null }>(
    'select owner_user_id from public.budgets where id = $1',
    [budgetId],
  );
  return rows[0]?.owner_user_id ?? null;
}
