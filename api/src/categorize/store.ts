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
import { transferOverview } from '../budget';

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

const NEEDS_CATEGORY_BODY = `
    and t.deleted = false
    and t.upcoming = false
    and t.amount <= 0
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
    and a.deleted = false
    and a.closed = false
    and a.on_budget = true
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

export const NEEDS_CATEGORY_WHERE = `where t.budget_id = $1 and t.category_id is null ${NEEDS_CATEGORY_BODY}`;

/**
 * The same rule without the "still uncategorized" term. Undo re-checks it so a
 * row that became an inflow, transfer or split since accept is left alone.
 */
export const NEEDS_CATEGORY_WHERE_IGNORING_CATEGORY = `where t.budget_id = $1 ${NEEDS_CATEGORY_BODY}`;

/**
 * An accept decision whose transaction has no category again: the person
 * cleared it by hand after accepting. `public.transactions` is shared with the
 * syscd-app, so no trigger cleans the record; readers treat it as no decision
 * and accept/skip replace it. Every query using this fragment already requires
 * `t.category_id is null`, so an accept decision there can only be stale.
 */
export const STALE_ACCEPT = `exists (
      select 1 from public.categorize_decisions sd
       where sd.transaction_id = t.id and sd.budget_id = t.budget_id and sd.kind = 'accept'
    )`;

/** The ids the app's transfer plan marks pending for this budget (register `transferPending`). */
export async function pendingTransferIds(db: Queryable, budgetId: string): Promise<string[]> {
  return [...(await transferOverview(db, budgetId)).pending.keys()];
}

export type NewSuggestion = {
  categoryId: string;
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
       (transaction_id, budget_id, outcome, error_kind, attempts, model, input_fingerprint, last_run_id, last_attempt_at)
    select t.id, t.budget_id, $3, $4, case when $6 = 'count' then 1 else 0 end, $5, ${ATTEMPT_FINGERPRINT}, $7, now()
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
           last_attempt_at = now()`,
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
      where transaction_id = $1 and budget_id = $2 and status <> 'pending'`,
    [transactionId, budgetId],
  );
}

/**
 * Replace one transaction's suggestion set atomically, and only while the
 * transaction is still live, uncategorized and in this budget: the row lock
 * makes a concurrent categorization win (then nothing is written).
 *
 * A transaction with any live decision is left alone: the person already
 * answered it, so no new suggestion may overwrite a decided one at its rank,
 * hide it behind a pending row, or resurrect a category they dismissed. The
 * exception is a STALE accept (its category was cleared by hand): its
 * suggestions are restored to pending and the run may answer again. Callers
 * skip such transactions too (`RUN_SKIP_WHERE`); this is the last line of
 * defence.
 *
 * Each row is inserted by SELECT over the transaction and the category, so a
 * category deleted or hidden between the call and this write is simply not
 * stored (R9) and the fingerprint written with it is the facts it answers.
 * Ranks above the new answer are dropped while pending only. Returns how many
 * pending suggestions are in place afterwards (0 when the answer named no
 * category the budget may still use).
 */
export async function replaceSuggestions(
  pool: Pool,
  budgetId: string,
  transactionId: string,
  suggestions: readonly NewSuggestion[],
): Promise<number> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query(
      'select 1 from public.transactions where id = $1 and budget_id = $2 and category_id is null and deleted = false for update',
      [transactionId, budgetId],
    );
    if (locked.rowCount === 0) return 0;
    const decisions = await client.query<{ kind: string }>(
      'select kind from public.categorize_decisions where transaction_id = $1 and budget_id = $2 for update',
      [transactionId, budgetId],
    );
    if (decisions.rows.some((row) => row.kind !== 'accept')) return 0;
    if (decisions.rows.length > 0) {
      await restorePendingSuggestions(client, budgetId, transactionId);
    } else {
      const existing = await client.query<{ status: string }>(
        'select status from public.category_suggestions where transaction_id = $1 and budget_id = $2',
        [transactionId, budgetId],
      );
      if (existing.rows.some((row) => row.status !== 'pending')) return 0;
    }
    let written = 0;
    // The rank counts the rows that land, so a category the budget may not use
    // (dropped by the SQL below) never leaves a hole in the set.
    for (const suggestion of suggestions) {
      const inserted = await client.query(
        `insert into public.category_suggestions
           (transaction_id, budget_id, rank, category_id, confidence, reason, source, provider, model, input_fingerprint)
         select t.id, t.budget_id, $3, c.id, $5, $6, $7, $8, $9, ${ATTEMPT_FINGERPRINT}
           from public.transactions t
           join public.categories c on c.id = $4 and c.budget_id = t.budget_id
           join public.category_groups g on g.id = c.group_id and g.budget_id = t.budget_id
           left join public.payees p on p.id = t.payee_id and p.budget_id = t.budget_id
           left join public.connection_transactions ct
                  on ct.transaction_id = t.id and ct.budget_id = t.budget_id
          where t.id = $1 and t.budget_id = $2 and ${ASSIGNABLE}
         on conflict (transaction_id, rank) do update
           set category_id = excluded.category_id, confidence = excluded.confidence,
               reason = excluded.reason, source = excluded.source,
               provider = excluded.provider, model = excluded.model,
               input_fingerprint = excluded.input_fingerprint, updated_at = now()
           where public.category_suggestions.status = 'pending'`,
        [
          transactionId,
          budgetId,
          written + 1,
          suggestion.categoryId,
          suggestion.confidence,
          suggestion.reason,
          suggestion.source,
          suggestion.provider,
          suggestion.model,
        ],
      );
      written += inserted.rowCount ?? 0;
    }
    await client.query(
      `delete from public.category_suggestions
        where transaction_id = $1 and rank > $2 and status = 'pending'`,
      [transactionId, written],
    );
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
