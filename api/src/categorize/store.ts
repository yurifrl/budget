/**
 * Categorize store: every SQL statement of the feature. Each function that
 * returns budget data takes the `budgetId` and puts it in the WHERE clause —
 * queries are scoped by construction, never by post-filtering.
 *
 * The only tables this feature writes are its own: suggestions go to
 * `category_suggestions`, attempts to `categorize_attempts`; 
 * `transactions.category_id` is read, never written.
 */
import type { Pool } from 'pg';

import type { Queryable } from '../core/db';
import { withTransaction } from '../core/db';
import { HttpError } from '../core/validate';
import { freeCounterpart, TRANSFER_PAIR_DAYS, transferOverview } from '../budget';

import type { CategorizeFailureKind } from '../jev';

/** Where a suggestion came from. 'payee_rule' answers first; 'jev' is the Jev classifier; 'manual' records a person's choice on accept. */
export type SuggestionSource = 'payee_rule' | 'jev' | 'manual';
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed';

/**
 * Bank facts the queue's merchant panel shows,
 * whitelisted from the provider payload. Every field is optional: the bank
 * sends what it sends, nothing is synthesized. There are deliberately no
 * location fields (the provider payload has none).
 *
 * `merchant` is the business side: trade name, legal name (`businessName`),
 * CNPJ and its CNAE/category (Pluggy merchant enrichment). `payment.
 * counterparty_name` is the PIX counterparty of THIS row (receiver for money
 * out, payer for money in). `operation_type` is the provider's operation
 * (PIX, TED, CARD …). Dropped: participant document numbers (CPF), bank
 * branch/account/routing numbers, reference ids, boleto lines and card
 * numbers — personal or bank identifiers, not evidence about the category.
 */
export type BankFacts = {
  description_raw?: string;
  category?: string;
  category_id?: string;
  operation_type?: string;
  status?: string;
  type?: string;
  merchant?: { name?: string; legal_name?: string; cnpj?: string; category?: string; cnae?: string };
  payment?: { method?: string; reason?: string; counterparty_name?: string };
  card?: { installment_number?: number; total_installments?: number; payee_mcc?: number; purchase_date?: string };
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;

/** Raw string of a bank field: trimmed, never capped or masked (the OWNER's data). */
const plain = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

type FieldReader = (value: unknown, options?: { mask?: boolean }) => string | undefined;

/**
 * The provider payload reduced to the facts the merchant panel may use.
 * `read` decides how strings are read. `amountMilliunits` picks the PIX
 * counterparty: the receiver for money out, the payer for money in.
 */
function readBankFacts(
  raw: Record<string, unknown> | null,
  amountMilliunits: number,
  read: FieldReader,
): BankFacts | null {
  if (!raw) return null;
  const merchant = record(raw.merchant);
  const payment = record(raw.paymentData);
  const card = record(raw.creditCardMetadata);
  const payerName = read(record(payment?.payer)?.name);
  const receiverName = read(record(payment?.receiver)?.name);
  const facts: BankFacts = {
    description_raw: read(raw.descriptionRaw, { mask: true }),
    category: read(raw.category),
    category_id: read(raw.categoryId),
    operation_type: read(raw.operationType),
    status: read(raw.status),
    type: read(raw.type),
    merchant: merchant
      ? {
          name: read(merchant.name),
          legal_name: read(merchant.businessName),
          cnpj: read(merchant.cnpj),
          category: read(merchant.category),
          cnae: read(merchant.cnae),
        }
      : undefined,
    payment: payment
      ? {
          method: read(payment.paymentMethod),
          reason: read(payment.reason, { mask: true }),
          counterparty_name: amountMilliunits < 0 ? receiverName : payerName,
        }
      : undefined,
    card: card
      ? {
          installment_number: int(card.installmentNumber),
          total_installments: int(card.totalInstallments),
          payee_mcc: int(card.payeeMCC),
          purchase_date: read(card.purchaseDate)?.slice(0, 10),
        }
      : undefined,
  };
  // Drop empty nested objects and undefined keys.
  for (const key of ['merchant', 'payment', 'card'] as const) {
    const value = facts[key];
    if (value && Object.values(value).every((v) => v === undefined)) delete facts[key];
  }
  return Object.values(facts).every((v) => v === undefined) ? null : facts;
}

/** USER-FACING: the owner's own bank data, unmasked and untruncated. */
export function userBankFacts(raw: Record<string, unknown> | null, amountMilliunits: number): BankFacts | null {
  return readBankFacts(raw, amountMilliunits, plain);
}

/** The facts the merchant panel shows; all null when the bank sent none. */
export type MerchantPanel = {
  name: string | null;
  legal_name: string | null;
  cnpj: string | null;
  business_category: string | null;
  operation_type: string | null;
  counterparty_name: string | null;
};

/**
 * USER-FACING merchant panel: no masking or caps. A record is kept only when at least one field exists.
 */
export function merchantPanel(
  raw: Record<string, unknown> | null,
  amountMilliunits: number,
): { raw_bank_description: string | null; merchant: MerchantPanel | null } {
  const facts = userBankFacts(raw, amountMilliunits);
  const merchant = facts?.merchant;
  const panel: MerchantPanel = {
    name: merchant?.name ?? null,
    legal_name: merchant?.legal_name ?? null,
    cnpj: merchant?.cnpj ?? null,
    business_category: merchant?.category ?? null,
    operation_type: facts?.operation_type ?? null,
    counterparty_name: facts?.payment?.counterparty_name ?? null,
  };
  const any = Object.values(panel).some((value) => value !== null);
  return { raw_bank_description: facts?.description_raw ?? null, merchant: any ? panel : null };
}

/** A category a suggestion may name (aliases `c` and `g` for categories and groups). */
export const ASSIGNABLE = `
  c.deleted = false and c.hidden = false and c.internal = false
  and g.deleted = false and g.hidden = false
  and g.is_credit_card_payments = false and g.internal = false`;

/**
 * The facts fingerprint of an attempt, the SAME expression the attempts table
 * stores: a transaction becomes a candidate again when its payee, memo, bank
 * text, amount, date or account changes, and only then. Any statement that
 * compares it must join the payee (`p`) and the bank payload (`ct`).
 */
export const ATTEMPT_FINGERPRINT = `md5(coalesce(t.payee_id::text, '') || '|' || coalesce(p.name, t.import_payee_name, '') || '|' || coalesce(t.memo, '') || '|' || t.amount::text || '|' || t.date::text || '|' || t.account_id::text || '|' || coalesce(ct.bank_text, ''))`;

/**
 * The register's "needs a category" rule (shared with the run), WITHOUT the
 * run's own bookkeeping. Args: $1 budget, $2 pending transfer ids. A run adds
 * its attempt/suggestion skips; the queue uses this base to show those rows.
 */
export const NEEDS_CATEGORY_FROM = `
  from public.transactions t
  join public.accounts a on a.id = t.account_id and a.budget_id = t.budget_id
  left join public.payees p on p.id = t.payee_id and p.budget_id = t.budget_id`;

/**
 * The bank payload of a transaction, joined so a statement can read
 * `ct.bank_text` / `ct.raw_payload` and compare `ATTEMPT_FINGERPRINT`. One
 * fragment for every statement that needs it, so the joins cannot drift apart.
 */
export const BANK_FACTS_JOIN = `left join public.connection_transactions ct on ct.transaction_id = t.id and ct.budget_id = t.budget_id`;

/**
 * THE definition of "decided", the one every reader and writer of this feature
 * uses: a decision row `d` of `categorize_decisions` about transaction `t` is the
 * person's STANDING decision about the row while it is still in effect —
 *  - a skip (whatever target column a released build left on it);
 *  - a category accept while the row still carries a category;
 *  - a transfer accept while the row still points at that account.
 * A decision no longer in effect (the category cleared by hand, the link undone
 * or edited in the register) is stale: the row is undecided again. Nothing else
 * decides a row: a "not a transfer" answer ({@link REFUSED}) only ends the
 * row's transfer question (an outflow still needs its category), and a
 * suggestion dismissed as the by-product of another answer is a fact about one
 * suggestion. Aliases: `t` the transaction, `d` the decision.
 */
const DECISION_IN_EFFECT = (d: string): string => `(
      ${d}.kind = 'skip'
      or (${d}.kind = 'accept' and t.category_id is not null)
      -- Never null (a 'transfer' decision always names its account), so
      -- \`not\` of this is exactly "stale".
      or (${d}.kind = 'transfer' and t.transfer_account_id is not distinct from ${d}.transfer_account_id))`;

/** Row `t` carries a standing decision ({@link DECISION_IN_EFFECT}). */
export const DECIDED = `exists (
      select 1 from public.categorize_decisions dd
       where dd.transaction_id = t.id and dd.budget_id = t.budget_id and ${DECISION_IN_EFFECT('dd')}
    )`;

/**
 * Row `t` carries a decision that is no longer in effect: the earlier CATEGORY
 * suggestions it settled (all but the person's own `manual` row) are live again.
 * Its transfer suggestions are not: the person already acted on the row (undid
 * the link, or filed a category over the transfer), so offering that transfer
 * again would undo their answer; a later run may propose one from scratch. The
 * page's own Undo is different: it restores the row exactly
 * ({@link restorePendingSuggestions}), so its suggestions are pending again.
 */
export const STALE_DECISION = `exists (
      select 1 from public.categorize_decisions sd
       where sd.transaction_id = t.id and sd.budget_id = t.budget_id and not ${DECISION_IN_EFFECT('sd')}
    )`;

/** Selects one boolean column per decision row `d` joined to its transaction `t`. */
export const DECISION_IN_EFFECT_COLUMN = `${DECISION_IN_EFFECT('d')} as in_effect`;

/**
 * The person answered "not a transfer" for row `t`. The answer is about the ROW,
 * whatever account the refused suggestion named (the refusal records it): no
 * transfer is offered, suggested, listed or accepted for the row again. Only the
 * person's own link in the register makes it a transfer after that.
 */
export const REFUSED = `exists (
        select 1 from public.categorize_transfer_refusals rf
         where rf.transaction_id = t.id and rf.budget_id = t.budget_id
      )`;

/**
 * May row `t` be answered "a transfer to/from `account`" right now, apart from
 * the account's own state (open, on budget, not the row's own — the register's
 * link checks that, with its own codes)? No "not a transfer" or "outside the
 * budget" mark on the row, no "not a transfer" answer about it ({@link REFUSED}),
 * and for an INFLOW a free
 * counterpart in THAT account (accept never invents a leg for money that
 * arrived). The Transfers read, the queue's placement and accept all read this.
 */
export const TRANSFER_PAIR_OPEN = (account: string): string => `
      not exists (
        select 1 from public.transfer_marks m
         where m.transaction_id = t.id and m.budget_id = t.budget_id
           and m.state in ('dismissed', 'outside')
      )
      and not ${REFUSED}
      and (t.amount <= 0 or exists (
        select 1 from public.transactions o
         where o.budget_id = t.budget_id and o.account_id = ${account}
           and ${freeCounterpart({ row: 'o', amount: '-t.amount', date: 't.date', days: String(TRANSFER_PAIR_DAYS) })}
      ))`;

/**
 * What every candidate shares: the row is live, not already a transfer the
 * register recognizes (a linked pointer, a transfer payee, a transfer hint), and
 * not split or refused by the person. Written without a leading `and`, so it can
 * be a parenthesised branch of a bigger test.
 */
const CANDIDATE_BASE = `
    t.deleted = false
    and t.upcoming = false
    -- A linked transfer keeps no category when its other side is an account
    -- still on budget: that is the register's own test (isTransferToOnBudget),
    -- read from the pointer rather than from the payee text.
    -- A pointer at the row's OWN account is not a transfer (the shared helper
    -- answers false on it), and the account must be this budget's: another
    -- budget's on-budget account leaves the money here.
    and not exists (
      select 1 from public.accounts ta
       where ta.id = t.transfer_account_id
         and ta.budget_id = t.budget_id
         and ta.id <> t.account_id
         and ta.deleted = false
         and ta.on_budget = true
    )
    and coalesce(p.name, t.import_payee_name, '') not in ('Reconciliation Adjustment', 'Balance Adjustment')
    and (
      p.transfer_account_id is null
      or not exists (
        select 1 from public.accounts ta
         where ta.id = p.transfer_account_id
           and ta.budget_id = t.budget_id
           and ta.id <> t.account_id
           and ta.deleted = false
           and ta.on_budget = true
      )
    )
    and (
      coalesce(p.name, t.import_payee_name, '') !~ '^Transfer[[:space:]]*:'
      or not exists (
        select 1 from public.accounts pa
         where pa.budget_id = t.budget_id
           and pa.deleted = false
           and pa.on_budget = true
           -- The peer is read trimmed, as the shared helper reads it.
           and lower(pa.name) = lower(btrim(regexp_replace(coalesce(p.name, t.import_payee_name, ''), '^Transfer[[:space:]]*:[[:space:]]*', '')))
      )
    )
    and not exists (select 1 from public.subtransactions s where s.transaction_id = t.id and s.deleted = false)
    and not (t.id = any($2::uuid[]))`;

/** An outflow that still needs a category, in an account the budget still counts. */
const CANDIDATE_OUTFLOW = `${CANDIDATE_BASE}
    and t.amount <= 0
    and a.deleted = false
    and a.closed = false
    and a.on_budget = true`;

/**
 * The incoming leg of a transfer: an inflow another account of the budget
 * answered with an opposite-signed row of the same amount within `days` or
 * less. Both sides are then candidates, so either one can be confirmed; the
 * other side must be a live row of an account this budget still has, because a
 * closed account cannot be the transfer's other side. `days` is a placeholder,
 * so the same rule serves the run's batch query ($5) and the single-row
 * re-check an accept does ($4).
 */
const candidateInflow = (days: string): string => `${CANDIDATE_BASE}
    and t.amount > 0
    and a.deleted = false
    and a.closed = false
    and a.on_budget = true
    -- The person already answered the transfer question about this row: "not a
    -- transfer" (the matcher's mark or Jev's refusal), or "a transfer to an
    -- account outside the budget". An inflow has no other question, so there is
    -- nothing left to ask.
    and not exists (
      select 1 from public.transfer_marks m
       where m.transaction_id = t.id and m.budget_id = t.budget_id
         and m.state in ('dismissed', 'outside')
    )
    and not ${REFUSED}
    -- The other leg, by the ONE rule every lookup uses (see freeCounterpart):
    -- a free, unlinked row of another open ON-BUDGET account, exact opposite
    -- amount, inside the same window. A counterpart that is already someone's
    -- transfer is not a pair, so the inflow is not a question at all.
    and exists (
      select 1
        from public.transactions o
        join public.accounts oa on oa.id = o.account_id and oa.budget_id = o.budget_id
       where o.budget_id = t.budget_id
         and o.account_id <> t.account_id
         and oa.deleted = false
         and oa.closed = false
         and oa.on_budget = true
         and ${freeCounterpart({ row: 'o', amount: '-t.amount', date: 't.date', days })}
    )`;

const CANDIDATE_INFLOW = candidateInflow('$5');

/**
 * A transaction's VISIBLE suggestions, best rank first: the ones the page could
 * still apply — a category the budget may use, or a transfer accept would take
 * now (an open on-budget account that is not the row's own, and
 * {@link TRANSFER_PAIR_OPEN}) — live and at or above the threshold. Live is
 * pending, or a category suggestion settled by a decision that is no longer in
 * effect ({@link STALE_DECISION}). A transfer that is not actionable is simply not
 * visible, so the row is placed by what is left. Arg: the threshold placeholder;
 * aliases `t` (the transaction).
 */
export const VISIBLE_SUGGESTIONS = (threshold: string): string => `
  select s.transaction_id, s.rank, s.category_id, s.transfer_account_id, s.confidence
    from public.category_suggestions s
    left join public.categories c on c.id = s.category_id and c.budget_id = s.budget_id
    left join public.category_groups g on g.id = c.group_id and g.budget_id = s.budget_id
    left join public.accounts ta on ta.id = s.transfer_account_id and ta.budget_id = s.budget_id
   where s.transaction_id = t.id
     and s.budget_id = t.budget_id
     and (s.status = 'pending' or (s.source <> 'manual' and s.category_id is not null and ${STALE_DECISION}))
     and s.confidence >= ${threshold}
     and (
       (s.category_id is not null and ${ASSIGNABLE})
       or (s.category_id is null
           and s.transfer_account_id is not null
           and ta.deleted = false and ta.closed = false and ta.on_budget = true
           and ta.id <> t.account_id
           and ${TRANSFER_PAIR_OPEN('s.transfer_account_id')})
     )
   order by s.rank`;

/**
 * The kind of a transaction's TOP visible suggestion ({@link VISIBLE_SUGGESTIONS}),
 * `category` or `transfer`, null when nothing is visible. A row belongs to the
 * Transfers section when this says `transfer` and to the category queue otherwise,
 * never both: the two sections page the same rows, so both count it once. Arg: the
 * threshold placeholder.
 */
export const TOP_SUGGESTION_KIND = (threshold: string): string => `(
  select case when top.category_id is not null then 'category' else 'transfer' end
    from (${VISIBLE_SUGGESTIONS(threshold)} limit 1) top
)`;

/**
 * The register's rule as the queue reads it: outflows that still need a
 * category. Inflows are never the queue's business (they are either transfers or
 * money arriving, and neither takes a category), so this fragment stays
 * outflow-only — the run's own rule below is the one that also asks about them.
 */
const NEEDS_CATEGORY_BODY = `
    and (${CANDIDATE_OUTFLOW})`;

export const NEEDS_CATEGORY_WHERE = `where t.budget_id = $1 and t.category_id is null ${NEEDS_CATEGORY_BODY}`;

/**
 * What a run may ask about: an outflow that needs a category, or an inflow whose
 * transfer counterpart exists. Args: $1 budget, $2 pending transfer ids,
 * $5 the counterpart window in days.
 */
export const RUN_CANDIDATE_WHERE = `
  where t.budget_id = $1
    and t.category_id is null
    and ((${CANDIDATE_OUTFLOW})
      or (${CANDIDATE_INFLOW}))`;

/**
 * May this row still be answered as a transfer? ONE rule, read by the Transfers
 * section and re-checked by accept, so the list cannot offer a row accept would
 * refuse: the run's candidate rule (an outflow needing a category, or an inflow
 * whose other leg is free) and no standing decision ({@link DECIDED}). The
 * per-account half (marks, refusals, an inflow's leg) is {@link TRANSFER_PAIR_OPEN}.
 *
 * Args: $1 budget, $2 the rows the transfer matcher holds, `days` the
 * counterpart window in days. Callers add their own predicates (a row id, a
 * confidence threshold) afterwards.
 */
export const TRANSFER_ASKABLE_WHERE = (days: string): string => `
  where t.budget_id = $1
    and t.category_id is null
    and ((${CANDIDATE_OUTFLOW})
      or (${candidateInflow(days)}))
    and not ${DECIDED}`;

/**
 * The same rule for ONE row and ONE account, which accept re-checks before
 * turning a suggestion into a transfer. Args: $1 budget, $2 the rows the
 * transfer matcher holds, $3 transaction id, $4 the counterpart window in days,
 * $5 the account.
 */
export const TRANSFER_OPEN_FOR_ROW = `${TRANSFER_ASKABLE_WHERE('$4')}
    and t.id = $3
    and ${TRANSFER_PAIR_OPEN('$5::uuid')}`;

/**
 * The same rule without the "still uncategorized" term. Undo re-checks it so a
 * row that became an inflow, transfer or split since accept is left alone.
 */
export const NEEDS_CATEGORY_WHERE_IGNORING_CATEGORY = `where t.budget_id = $1 ${NEEDS_CATEGORY_BODY}`;

/** The ids the app's transfer plan marks pending for this budget (register `transferPending`). */
export async function pendingTransferIds(db: Queryable, budgetId: string): Promise<string[]> {
  return [...(await transferOverview(db, budgetId)).pending.keys()];
}

/**
 * Every row the transfer matcher holds an opinion about: its current suggestions
 * and its pending rows. Those rows are shown — and decided — in the transfer
 * lists, so neither the Jev run nor Jev's own transfer read asks about them
 * again: a row appears once, where the person can see both of its sides.
 */
export async function matcherRowIds(db: Queryable, budgetId: string): Promise<string[]> {
  const overview = await transferOverview(db, budgetId);
  return [...new Set([...overview.rows.keys(), ...overview.pending.keys()])];
}

/**
 * One suggestion to store: a category, or a transfer to one of the budget's own
 * accounts. The target is what the suggestion means; the insert turns it into
 * `category_id` or `transfer_account_id` (the table's check allows exactly one).
 */
export type SuggestionTarget =
  | { kind: 'category'; categoryId: string }
  | { kind: 'transfer'; accountId: string };

export type NewSuggestion = {
  target: SuggestionTarget;
  confidence: number;
  reason: string | null;
  source: SuggestionSource;
  provider: string | null;
  model: string | null;
};

export type AttemptOutcome = 'suggested' | 'no_suggestion' | 'failed';

/** One row of public.categorize_attempts (no transaction id: this is the per-row shape). */
export type CategorizeAttempt = {
  outcome: AttemptOutcome;
  error_kind: string | null;
  attempts: number;
  model: string | null;
  last_attempt_at: string;
};

/**
 * Record one attempt for a live, still-uncategorized transaction of this
 * budget, stamped with the run that made it (a redelivered run skips the rows
 * it already answered).
 *
 * `attempts` counts CONSECUTIVE row-level failures and nothing else: a success
 * resets it to 0, a row-level failure adds one (or starts a fresh count at 1
 * when the facts changed), and an answer Jev never gave — a rate limit, an
 * outage — keeps it as it was. The row is stamped with the run even when the
 * person categorized or deleted it meanwhile (the run did ask it); only a
 * row of another budget, or one that no longer exists, returns false.
 *
 * The fingerprint is computed in SQL from the SAME expression the candidate
 * query compares, so an answer is skipped exactly while the facts are
 * unchanged.
 */
export async function recordAttempt(
  db: Queryable,
  budgetId: string,
  transactionId: string,
  runId: string,
  attempt: {
    outcome: AttemptOutcome;
    errorKind: CategorizeFailureKind | null;
    model: string | null;
    /** What the failure does to the cap: `count` a row-level failure, `keep` a service one, `reset` a success. */
    attempts: 'count' | 'keep' | 'reset';
  },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into public.categorize_attempts
       (transaction_id, budget_id, outcome, error_kind, attempts, model, input_fingerprint, last_run_id, last_attempt_at,
        hour_calls, hour_started_at)
    select t.id, t.budget_id, $3, $4, case when $6 = 'count' then 1 else 0 end, $5, ${ATTEMPT_FINGERPRINT}, $7, now(),
           case when $5::text is null then 0 else 1 end, case when $5::text is null then null else now() end
       from public.transactions t
       left join public.payees p on p.id = t.payee_id and p.budget_id = t.budget_id
       left join public.connection_transactions ct
              on ct.transaction_id = t.id and ct.budget_id = t.budget_id
      where t.id = $1 and t.budget_id = $2
     on conflict (transaction_id) do update
       set outcome = excluded.outcome,
           error_kind = excluded.error_kind,
          attempts = case
            when $6 = 'reset' then 0
            when $6 = 'keep' then public.categorize_attempts.attempts
            when public.categorize_attempts.input_fingerprint = excluded.input_fingerprint
              then public.categorize_attempts.attempts + 1
            else 1 end,
           model = excluded.model,
           input_fingerprint = excluded.input_fingerprint,
           last_run_id = excluded.last_run_id,
           last_attempt_at = now(),
           -- The hourly allowance (run-store hourlyUse): a call that cost adds
           -- one inside the row's window, or opens a new window at 1.
           hour_calls = case
             when public.categorize_attempts.hour_started_at > now() - interval '1 hour'
               then public.categorize_attempts.hour_calls + excluded.hour_calls
             else excluded.hour_calls end,
           hour_started_at = case
             when public.categorize_attempts.hour_started_at > now() - interval '1 hour'
               then public.categorize_attempts.hour_started_at
             else excluded.hour_started_at end`,
    [transactionId, budgetId, attempt.outcome, attempt.errorKind, attempt.model, attempt.attempts, runId],
  );
  return (rowCount ?? 0) > 0;
}

export type AttemptRow = CategorizeAttempt & {
  transaction_id: string;
  date: string;
  amount_milliunits: number;
  payee: string | null;
  account_id: string;
  account_name: string;
  memo: string | null;
};

export type AttemptListOptions = {
  /** Restrict to one transaction (the page's one-by-one view); must be a uuid. */
  transactionId?: string;
  limit: number;
  offset: number;
};

/**
 * The attempts the queue reads to tell "not classified yet" (no row for the
 * transaction) from "classified, no suggestion" (outcome no_suggestion) and
 * "failed" (with its kind). Per-transaction, newest date first.
 */
export async function listAttempts(
  db: Queryable,
  budgetId: string,
  options: AttemptListOptions,
): Promise<{ rows: AttemptRow[]; total: number }> {
  if (options.transactionId !== undefined && !UUID_RE.test(options.transactionId)) {
    throw new HttpError(400, 'transaction id must be a uuid', 'invalid_transaction_id');
  }
  const where = `t.budget_id = $1 and t.deleted = false
    ${options.transactionId ? 'and t.id = $2' : ''}`;
  const args: unknown[] = [budgetId];
  if (options.transactionId) args.push(options.transactionId);
  const limitAt = args.length + 1;
  const offsetAt = args.length + 2;
  const from = `from public.categorize_attempts ca
    join public.transactions t on t.id = ca.transaction_id and t.budget_id = ca.budget_id
    join public.accounts a on a.id = t.account_id and a.budget_id = ca.budget_id
    left join public.payees p on p.id = t.payee_id and p.budget_id = ca.budget_id`;
  const total = await db.query<{ n: number }>(`select count(*)::int as n ${from} where ${where}`, args);
  const { rows } = await db.query<AttemptRow & { account_name: string }>(
    `select ca.transaction_id, ca.outcome, ca.error_kind, ca.attempts, ca.model,
            ca.last_attempt_at::text as last_attempt_at,
            t.date::text as date, t.amount as amount_milliunits,
            coalesce(p.name, t.import_payee_name) as payee,
            t.account_id, a.name as account_name, t.memo
       ${from}
      where ${where}
      order by t.date desc, t.id
      limit $${limitAt} offset $${offsetAt}`,
    [...args, options.limit, options.offset],
  );
  // USER-FACING: the owner's own text, never capped or masked.
  return { rows, total: total.rows[0]?.n ?? 0 };
}

/**
 * Undo's restore, reused for a stale accept: the person's manual row goes and
 * the suggested rows are pending again, so the next accept/skip/engine write
 * starts from the state accept requires.
 */
export async function restorePendingSuggestions(db: Queryable, budgetId: string, transactionId: string): Promise<void> {
  await db.query(
    `delete from public.category_suggestions
      where transaction_id = $1 and budget_id = $2 and source = 'manual'`,
    [transactionId, budgetId],
  );
  await db.query(
    `update public.category_suggestions
        set status = 'pending', updated_at = now()
      where transaction_id = $1 and budget_id = $2 and status <> 'pending'
        -- A row the person answered "not a transfer" stays refused: reviving a
        -- transfer suggestion would put it back in the Transfers list they answered.
        and (transfer_account_id is null
          or not exists (
            select 1 from public.categorize_transfer_refusals rf
             where rf.transaction_id = $1 and rf.budget_id = $2
          ))`,
    [transactionId, budgetId],
  );
}

/**
 * Replace one transaction's suggestion set atomically, and only while the
 * transaction is still live, uncategorized, in this budget and UNDECIDED
 * ({@link DECIDED}): the row lock makes a concurrent categorization or decision
 * win. Returns null when nothing was written for that reason — the answer is
 * dropped, and the caller must not count it as an answer.
 *
 * An undecided row's earlier suggestions are no decision of the person's (a
 * refused transfer is remembered in its own table, a suggestion a stale
 * decision settled is not in effect), so the new answer replaces them all.
 *
 * Each row is inserted by SELECT over the transaction and the category, so a
 * category deleted or hidden between the call and this write is simply not
 * stored (R9) and the fingerprint written with it is the facts it answers.
 * Returns how many suggestions were written (0 when the answer named no target
 * the budget may still use).
 */
export async function replaceSuggestions(
  pool: Pool,
  budgetId: string,
  transactionId: string,
  suggestions: readonly NewSuggestion[],
): Promise<number | null> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<{ decided: boolean }>(
      `select ${DECIDED} as decided from public.transactions t
        where t.id = $1 and t.budget_id = $2 and t.category_id is null and t.deleted = false
        for update`,
      [transactionId, budgetId],
    );
    if (locked.rows[0] === undefined || locked.rows[0].decided) return null;
    await client.query('delete from public.category_suggestions where transaction_id = $1 and budget_id = $2', [
      transactionId,
      budgetId,
    ]);
    let written = 0;
    // The rank counts the rows that land, so a category the budget may not use
    for (const suggestion of suggestions) {
      const { target } = suggestion;
      // Two selects, one row: a category suggestion is stored only while the
      // category is one the budget may still use, a transfer suggestion only
      // while the account is open and is not the row's own.
      const source =
        target.kind === 'category'
          ? `join public.categories c on c.id = $4 and c.budget_id = t.budget_id
             join public.category_groups g on g.id = c.group_id and g.budget_id = t.budget_id
             where t.id = $1 and t.budget_id = $2 and ${ASSIGNABLE}`
          : `join public.accounts ta on ta.id = $4 and ta.budget_id = t.budget_id
             where t.id = $1 and t.budget_id = $2
               and ta.deleted = false and ta.closed = false and ta.on_budget = true
               and ta.id <> t.account_id`;
      const targetColumn = target.kind === 'category' ? 'category_id' : 'transfer_account_id';
      const targetId = target.kind === 'category' ? target.categoryId : target.accountId;
      const inserted = await client.query(
        `insert into public.category_suggestions
           (transaction_id, budget_id, rank, ${targetColumn}, confidence, reason, source, provider, model, input_fingerprint)
         select t.id, t.budget_id, $3, ${target.kind === 'category' ? 'c.id' : 'ta.id'}, $5, $6, $7, $8, $9, ${ATTEMPT_FINGERPRINT}
           from public.transactions t
           left join public.payees p on p.id = t.payee_id and p.budget_id = t.budget_id
           left join public.connection_transactions ct
                  on ct.transaction_id = t.id and ct.budget_id = t.budget_id
           ${source}`,
        [
          transactionId,
          budgetId,
          written + 1,
          targetId,
          suggestion.confidence,
          suggestion.reason,
          suggestion.source,
          suggestion.provider,
          suggestion.model,
        ],
      );
      written += inserted.rowCount ?? 0;
    }
    return written;
  });
}

export type SuggestionListOptions = {
  /** Only suggestions at or above this confidence (0..1). Applied at read time. */
  minConfidence: number;
  status?: SuggestionStatus;
  /** Restrict to one transaction (the page's one-by-one view); must be a uuid. */
  transactionId?: string;
  limit: number;
  offset: number;
};

export type SuggestionRow = {
  transaction_id: string;
  rank: number;
  category_id: string;
  category_name: string;
  group_id: string;
  group_name: string;
  confidence: number;
  reason: string | null;
  source: SuggestionSource;
  provider: string | null;
  model: string | null;
  status: SuggestionStatus;
  date: string;
  amount_milliunits: number;
  payee: string | null;
  account_id: string;
  account_name: string;
  memo: string | null;
  /** Bank facts the queue's merchant panel shows; null when the row is not bank-imported. */
  bank: BankFacts | null;
  /** The latest attempt for the transaction; null while it was never attempted. */
  attempt: CategorizeAttempt | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Suggestions the page may show: pending by default, at/above the threshold,
 * for live uncategorized transactions of this budget only (a transaction
 * categorized by hand after the run drops out of the queue). Hidden/deleted
 * categories and groups and deleted accounts are filtered here as well as at
 * write time, so an old row can never surface through a later hide.
 *
 * USER-FACING: the owner's own text is returned as stored (never masked or
 * capped). The caller (the HTTP layer) checks budget ACCESS: this query is
 * scoped by `budgetId` only. A non-uuid `transactionId` is a validation error,
 * not a driver error, because callers pass it through from a parameter.
 */
export async function listSuggestions(
  db: Queryable,
  budgetId: string,
  options: SuggestionListOptions,
): Promise<{ rows: SuggestionRow[]; total: number }> {
  if (options.transactionId !== undefined && !UUID_RE.test(options.transactionId)) {
    throw new HttpError(400, 'transaction id must be a uuid', 'invalid_transaction_id');
  }
  const from = `from public.category_suggestions s
    join public.transactions t on t.id = s.transaction_id and t.budget_id = s.budget_id
    join public.categories c on c.id = s.category_id and c.budget_id = s.budget_id
    join public.category_groups g on g.id = c.group_id and g.budget_id = s.budget_id
    join public.accounts a on a.id = t.account_id and a.budget_id = s.budget_id
    left join public.payees p on p.id = t.payee_id and p.budget_id = s.budget_id
    left join public.connection_transactions ct on ct.transaction_id = t.id and ct.budget_id = s.budget_id
    left join public.categorize_attempts ca on ca.transaction_id = t.id and ca.budget_id = s.budget_id`;
  const where = `s.budget_id = $1 and s.status = $2 and s.confidence >= $3
    and t.deleted = false and t.category_id is null
    and c.deleted = false and c.hidden = false and c.internal = false
    and g.deleted = false and g.hidden = false
    and g.is_credit_card_payments = false and g.internal = false
    and a.deleted = false
    ${options.transactionId ? 'and s.transaction_id = $4' : ''}`;
  const args: unknown[] = [budgetId, options.status ?? 'pending', options.minConfidence];
  if (options.transactionId) args.push(options.transactionId);
  const limitAt = args.length + 1;
  const offsetAt = args.length + 2;
  const total = await db.query<{ n: number }>(`select count(*)::int as n ${from} where ${where}`, args);
  const { rows } = await db.query<Omit<SuggestionRow, 'bank'> & { raw_payload: Record<string, unknown> | null }>(
    `select s.transaction_id, s.rank, s.category_id, c.name as category_name,
            g.id as group_id, g.name as group_name,
            s.confidence, s.reason, s.source, s.provider, s.model, s.status,
            t.date::text as date, t.amount as amount_milliunits,
            coalesce(p.name, t.import_payee_name) as payee,
            t.account_id, a.name as account_name, t.memo, ct.raw_payload,
            case when ca.transaction_id is null then null else
              json_build_object('outcome', ca.outcome, 'error_kind', ca.error_kind, 'attempts', ca.attempts,
                                'model', ca.model, 'last_attempt_at', ca.last_attempt_at::text)
            end as attempt
       ${from}
      where ${where}
      order by t.date desc, t.id, s.rank
      limit $${limitAt} offset $${offsetAt}`,
    [...args, options.limit, options.offset],
  );
  // USER-FACING: the owner's own text and bank data, never capped or masked.
  return {
    rows: rows.map(({ raw_payload, ...row }) => ({
      ...row,
      bank: userBankFacts(raw_payload, row.amount_milliunits),
    })),
    total: total.rows[0]?.n ?? 0,
  };
}
