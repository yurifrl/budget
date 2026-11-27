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

import type { Queryable } from '../core/db';

import { freeCounterpart, TRANSFER_PAIR_DAYS } from '../budget';
import { JEV_MAX_OPTIONS } from '../jev';

import { ATTEMPT_FINGERPRINT, BANK_FACTS_JOIN, DECIDED, NEEDS_CATEGORY_FROM, REFUSED, RUN_CANDIDATE_WHERE } from './store';
import { CATEGORIZE_RUN_JOB } from './job';

/** How far apart the two legs of one transfer may be dated: the budget's one window. */
export const TRANSFER_WINDOW_DAYS = TRANSFER_PAIR_DAYS;

export type RunCandidate = {
  transaction_id: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Signed integer milliunits; an outflow is negative. */
  amount: number;
  payee_id: string | null;
  payee: string | null;
  account_name: string;
  /** What kind of account the row sits in (`transactions` account `type`). */
  account_kind: string;
  account_id: string;
  memo: string | null;
  /** The bank's own text for the row (`connection_transactions.bank_text`). */
  bank_text: string | null;
  raw_payload: Record<string, unknown> | null;
  /**
   * The person already answered the transfer question for this row with "not a
   * transfer" (the matcher's `dismissed` mark or Jev's refusal, `REFUSED`), so a
   * transfer is never offered for it again. A `manual` mark (a link they undid)
   * is only "suggest, never auto-link", and an old `outside` mark is no answer
   * at all (budget-dt00): the row is still asked.
   */
  transfer_refused: boolean;
};

/**
 * The run's half of the candidate rule. Args: $1 budget, $2 the rows the
 * transfer matcher holds, $3 max attempts per transaction, $4 the run that is
 * asking.
 *
 * A row is skipped when (a) it carries a standing decision ({@link DECIDED}: a
 * stale one, whose category or link is gone, no longer answers for the row),
 * (b) it already has
 * pending suggestions made from the facts it still carries, (c) its last
 * answer was "no suggestion" for those same facts, (d) its recorded failures
 * reached the cap **for the facts it still carries**, or (e) THIS run already
 * touched it — so a redelivered run never asks again about a row it answered,
 * nor about the one it was holding when the worker died. (d) needs the facts
 * too: a row that failed out and then changed is new information, and skipping
 * it forever would bury it.
 */
export const RUN_SKIP_WHERE = `
    and not ${DECIDED}
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
 * `taken` is every row this delivery already handed to a worker. A row is only
 * stamped (its attempt row written) once its call settles, so a page fetched
 * while rows are in flight would otherwise return them again; excluding them
 * keeps "handed out once" true even though 4 calls overlap. Args: $1 budget,
 * $2 pending transfer ids, $3 max attempts per transaction, $4 the run id,
 * $5 the counterpart window in days, $6 page size, $7 rows already handed out.
 */
export async function runCandidates(
  db: Queryable,
  budgetId: string,
  transferIds: string[],
  maxAttempts: number,
  runId: string,
  pageSize: number,
  taken: string[],
): Promise<RunCandidate[]> {
  const { rows } = await db.query<RunCandidate>(
    `select t.id as transaction_id, t.date::text as date, t.amount,
            t.payee_id, coalesce(p.name, t.import_payee_name) as payee,
            a.name as account_name, a.type as account_kind, t.account_id, t.memo,
            ct.bank_text, ct.raw_payload,
            (coalesce(m.state = 'dismissed', false) or ${REFUSED}) as transfer_refused
       ${NEEDS_CATEGORY_FROM}
       ${BANK_FACTS_JOIN}
       left join public.transfer_marks m on m.transaction_id = t.id and m.budget_id = t.budget_id
      ${RUN_CANDIDATE_WHERE}
      ${RUN_SKIP_WHERE}
        and not (t.id = any($7::uuid[]))
      order by t.date desc, t.id
      limit $6`,
    [budgetId, transferIds, maxAttempts, runId, TRANSFER_WINDOW_DAYS, pageSize, taken],
  );
  return rows;
}

/**
 * How many rows are waiting right now, uncapped: the same rule as
 * runCandidates with the run id left null (no attempt carries a null
 * last_run_id, so only the other predicates apply — exactly what a fresh run
 * would find). It counts TRANSFER candidates too, so it is what a run started
 * now would ask about; the page sizes its run input and its empty state from
 * this, and the hour's allowance trims it separately.
 */
export async function candidateWaiting(
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
          ${RUN_CANDIDATE_WHERE}
           ${RUN_SKIP_WHERE}
       ) rows`,
    [budgetId, transferIds, maxAttempts, null, TRANSFER_WINDOW_DAYS],
  );
  return rows[0]?.n ?? 0;
}

/**
 * The possible other sides of a transfer for one row, closest first, by the ONE
 * counterpart rule ({@link freeCounterpart}), none for a row the person
 * answered "not a transfer" ({@link REFUSED}) — the same rules the candidate rule and the accept use, so the fact Jev is told is
 * the pair accept would find and the accounts an inflow is offered are exactly
 * the ones accept would take. Asked for inflows only (an outflow's counterpart
 * is the incoming leg, which the same rule finds).
 */
export async function transferCounterparts(
  db: Queryable,
  budgetId: string,
  transactionId: string,
): Promise<{ transaction_id: string; account_id: string; account_name: string }[]> {
  const { rows } = await db.query<{ transaction_id: string; account_id: string; account_name: string }>(
    `select o.id as transaction_id, o.account_id, oa.name as account_name
       from public.transactions t
       join public.transactions o
         on o.budget_id = t.budget_id and o.account_id <> t.account_id
       join public.accounts oa on oa.id = o.account_id and oa.budget_id = o.budget_id
      where t.id = $1 and t.budget_id = $2
        and oa.deleted = false and oa.closed = false and oa.on_budget = true
        and ${freeCounterpart({ row: 'o', amount: '-t.amount', date: 't.date', days: '$3' })}
        and not ${REFUSED}
      order by abs(o.date - t.date), o.date desc, o.id`,
    [transactionId, budgetId, TRANSFER_WINDOW_DAYS],
  );
  return rows;
}

export type AccountOption = { id: string; name: string };

/**
 * Every open ON-BUDGET account of the budget, in the page's own order: a transfer
 * option names one of these (all of them but the row's own). An off-budget
 * account is never a transfer target here — the register refuses to link one —
 * so offering it would promise an accept that cannot happen.
 */
export async function openAccounts(db: Queryable, budgetId: string): Promise<AccountOption[]> {
  const { rows } = await db.query<AccountOption>(
    `select id, name
       from public.accounts
      where budget_id = $1 and deleted = false and closed = false and on_budget = true
      order by sort_order, name`,
    [budgetId],
  );
  return rows;
}

/** What one call may offer, and the ceiling those options must fit in. */
export type OfferedOptions = {
  categories: CategoryOption[];
  accounts: AccountOption[];
  /**
   * The most options one call can carry: every category plus every open account
   * but the row's own. Jev takes {@link JEV_MAX_OPTIONS}, so a run whose budget
   * exceeds this cannot be answered and says so instead of sending a truncated
   * list. The run refuses on it and the start check refuses with it, so both
   * read one number.
   */
  ceiling: number;
};

/**
 * What this budget may offer one call. Categories are read one past Jev's limit,
 * so "too many" is a fact rather than a guess; the ceiling counts the accounts
 * too, because each is a transfer option of its own.
 */
export async function offeredOptions(db: Queryable, budgetId: string): Promise<OfferedOptions> {
  const categories = await assignableCategories(db, budgetId, JEV_MAX_OPTIONS + 1);
  const accounts = await openAccounts(db, budgetId);
  return { categories, accounts, ceiling: categories.length + Math.max(0, accounts.length - 1) };
}

/** The rolling hour's sending allowance, as the page and the start check read it. */
export type HourlyUse = {
  /** Transactions sent in the last hour, across every run of this budget. */
  used: number;
  /** Minutes until the hour frees a slot; null when nothing was sent. */
  freesInMinutes: number | null;
};

/**
 * What this budget spent of its hourly allowance: the CALLS made in the rolling
 * hour, from each row's call counter (`categorize_attempts.hour_calls`, the calls
 * since `hour_started_at`; see recordAttempt). A row sent twice in the hour
 * counts twice. Every counted call happened at or after its window's start,
 * which is inside the hour, so the figure can only under-count (calls of a
 * window that started more than an hour ago are dropped whole), never
 * over-count — right for a safety limit. A call whose answer was never used
 * (nothing to ask, or the row was decided while Jev answered) is stamped with no
 * model and costs nothing.
 */
export async function hourlyUse(db: Queryable, budgetId: string): Promise<HourlyUse> {
  const { rows } = await db.query<{ n: number; frees_in_minutes: number | null }>(
    `select coalesce(sum(hour_calls), 0)::int as n,
            ceil(extract(epoch from (min(hour_started_at) + interval '1 hour' - now())) / 60)::int
              as frees_in_minutes
       from public.categorize_attempts
      where budget_id = $1 and hour_started_at > now() - interval '1 hour' and hour_calls > 0`,
    [budgetId],
  );
  const used = rows[0]?.n ?? 0;
  const frees = rows[0]?.frees_in_minutes ?? null;
  return { used, freesInMinutes: used === 0 || frees === null ? null : Math.max(0, frees) };
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
