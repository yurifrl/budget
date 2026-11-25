/**
 * Categorize store: every SQL statement of the feature. Each function that
 * returns budget data takes the `budgetId` and puts it in the WHERE clause —
 * the model's tools are scoped by construction, never by post-filtering.
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
import type { CategorizeFailureKind } from './errors';
import { CATEGORIZE_MAX_ATTEMPTS } from './jobspec';

/** Where a suggestion came from. 'payee_rule' answers first; 'ai' is the model; 'manual' records a person's choice on accept. */
export type SuggestionSource = 'payee_rule' | 'ai' | 'manual';
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed';

/**
 * Bank facts worth showing the model and the queue's merchant panel,
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

/** The transaction shape the agent sees (milliunits, ISO dates, no internals). */
export type AgentTransaction = {
  id: string;
  date: string;
  amount_milliunits: number;
  account: { name: string; type: string; currency: string | null };
  payee: string | null;
  payee_id: string | null;
  memo: string | null;
  category: { id: string; name: string } | null;
  bank: BankFacts | null;
};

/** One candidate row for a run (the provider payload is reduced to `bank`). */
export type Candidate = AgentTransaction;

/** Keyset position of a candidate: newest first, `(date, id)` is unique and stable. */
export type CandidateCursor = { date: string; id: string };

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;

/** Longest untrusted text (bank text, payee, memo, category note) that may reach a prompt. */
export const MAX_UNTRUSTED_TEXT_CHARS = 200;
/** Longest category/payee name in a tool result; names are user text too. */
export const MAX_NAME_CHARS = 80;

const cap = (value: string, max = MAX_UNTRUSTED_TEXT_CHARS): string => value.slice(0, max);

/**
 * Mask CPF/CNPJ-shaped and account-shaped digit runs in free bank text before
 * it reaches a prompt or the queue. Brazilian `descriptionRaw` and the PIX
 * `reason` are payer/bank free text and often embed the counterpart's CPF or an
 * account number. The structured `merchant.cnpj` is a business identifier and
 * is kept (the merchant panel uses it); personal documents never are.
 */
export function maskFreeText(value: string): string {
  return value
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '***') // formatted CPF
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '***') // formatted CNPJ
    .replace(/\b\d{11}\b/g, '***') // bare CPF
    .replace(/\b\d{14}\b/g, '***') // bare CNPJ
    .replace(/\b\d{6,}\b/g, '***'); // account / reference number runs
}

/**
 * One bank string, safe for a prompt: trimmed, capped, and masked when it is
 * free text (`mask` true for `descriptionRaw` / PIX `reason`).
 */
const text = (value: unknown, { mask = false }: { mask?: boolean } = {}): string | undefined => {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const trimmed = cap(value.trim());
  return mask ? maskFreeText(trimmed) : trimmed;
};

/** Raw string of a bank field: trimmed, never capped or masked (the OWNER's data). */
const plain = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

type FieldReader = (value: unknown, options?: { mask?: boolean }) => string | undefined;

/**
 * The provider payload reduced to the facts a classifier (or the merchant
 * panel) may use. `read` decides whether strings are model-safe (capped,
 * free text masked) or the user's own values. `amountMilliunits` picks the PIX
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
  // Drop empty nested objects and undefined keys so the prompt stays small.
  for (const key of ['merchant', 'payment', 'card'] as const) {
    const value = facts[key];
    if (value && Object.values(value).every((v) => v === undefined)) delete facts[key];
  }
  return Object.values(facts).every((v) => v === undefined) ? null : facts;
}

/** MODEL-FACING: capped and (for free bank text) masked. Never for a user response. */
export function bankFacts(raw: Record<string, unknown> | null, amountMilliunits: number): BankFacts | null {
  return readBankFacts(raw, amountMilliunits, text);
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
 * USER-FACING merchant panel: same extraction as the model's bankFacts, but
 * no masking or caps. A record is kept only when at least one field exists.
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

/** The budget owner: the person whose AI key a run uses. Null when no such budget (or no owner). */
export async function budgetOwner(db: Queryable, budgetId: string): Promise<string | null> {
  const { rows } = await db.query<{ owner_user_id: string }>(
    'select owner_user_id from public.budgets where id = $1',
    [budgetId],
  );
  return rows[0]?.owner_user_id ?? null;
}

/**
 * Who a categorize run acts for — THE single place this product decision lives.
 * Today it is the budget OWNER: the owner's own key pays (or the shared key
 * when the feature is enabled for them), and the ledger tenant is the owner.
 * A member of a shared budget can therefore trigger a run that spends the
 * owner's key; changing that (for example "the requester's key") is a change
 * to this function only. Null when the budget is gone.
 */
export async function runActorForBudget(db: Queryable, budgetId: string): Promise<string | null> {
  return budgetOwner(db, budgetId);
}

/**
 * Candidate SQL: `needsCategory` (shared/src/domain/category-needs.ts) for the
 * register's rule, plus the facts a run may not act on.
 *
 * The transfer-pending half of the rule is NOT re-implemented here: the app's
 * own transfer plan (`transferOverview`, the source of the register's
 * `transferPending`) computes the pending ids and the query excludes them.
 * `candidate-rule.test.ts` runs this SQL and the shared predicate over the
 * same fixture rows and compares the sets, so the two cannot drift.
 *
 * Excluded here: inflows (money in goes to Ready to Assign), rows on
 * off-budget/tracking or closed or deleted accounts, split parents, upcoming
 * occurrences, linked transfers, rows on internal "Transfer : <account>"
 * payees, reconciliation/balance adjustments, transfer-plan pending rows
 * (payee rule waiting or kept outside the budget), after a first run rows with
 * suggestions, and rows whose recorded attempt says "no suggestion" (same
 * payee/memo) or "failed" (still backing off / out of attempts).
 *
 * Args (run query): $1 budget, $2 pending transfer ids, $3 force, $4 max
 * failed attempts.
 */

/**
 * The payee+memo fingerprint of an attempt, the SAME expression the attempts
 * table stores: a no_suggestion transaction becomes a candidate again when its
 * payee or memo changes, and only then.
 */
const ATTEMPT_FINGERPRINT = `md5(coalesce(t.payee_id::text, '') || '|' || coalesce(p.name, t.import_payee_name, '') || '|' || coalesce(t.memo, ''))`;

/**
 * The register's "needs a category" rule (shared with the run), WITHOUT the
 * run's own bookkeeping. Args: $1 budget, $2 pending transfer ids. A run adds
 * its attempt/suggestion skips; the queue uses this base to show those rows.
 */
export const NEEDS_CATEGORY_FROM = `
  from public.transactions t
  join public.accounts a on a.id = t.account_id and a.budget_id = t.budget_id
  left join public.payees p on p.id = t.payee_id and p.budget_id = t.budget_id`;

const NEEDS_CATEGORY_BODY = `
    and t.deleted = false
    and t.upcoming = false
    and t.amount <= 0
    and t.transfer_transaction_id is null
    and t.transfer_account_id is null
    and a.deleted = false
    and a.closed = false
    and a.on_budget = true
    and coalesce(p.name, t.import_payee_name, '') not in ('Reconciliation Adjustment', 'Balance Adjustment')
    and (
      p.transfer_account_id is null
      or not exists (
        select 1 from public.accounts ta
         where ta.id = p.transfer_account_id
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
           and lower(pa.name) = lower(regexp_replace(coalesce(p.name, t.import_payee_name, ''), '^Transfer[[:space:]]*:[[:space:]]*', ''))
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
 * The run adds: skip rows with any suggestion, and rows whose attempt says
 * no-suggestion (same payee/memo fingerprint) or failed (still backing off /
 * out of attempts). Args: $3 force, $4 max failed attempts.
 */
const CANDIDATE_FROM = NEEDS_CATEGORY_FROM;
const CANDIDATE_WHERE = `${NEEDS_CATEGORY_WHERE}
    and not exists (
      select 1 from public.categorize_decisions cd
       where cd.transaction_id = t.id and cd.budget_id = t.budget_id
    )
    and (
      $3::boolean
      or not exists (select 1 from public.category_suggestions cs where cs.transaction_id = t.id)
    )
    and (
      $3::boolean
      or not exists (
        select 1 from public.categorize_attempts ca
         where ca.transaction_id = t.id
           and (
             (ca.outcome = 'no_suggestion' and ca.input_fingerprint = ${ATTEMPT_FINGERPRINT})
             or (ca.outcome = 'failed'
                 and (ca.attempts >= $4::int
                      or ca.last_attempt_at > now() - least(interval '10 minutes' * power(2::float8, ca.attempts - 1), interval '6 hours')))
           )
      )
    )`;

/** The ids the app's transfer plan marks pending for this budget (register `transferPending`). */
export async function pendingTransferIds(db: Queryable, budgetId: string): Promise<string[]> {
  return [...(await transferOverview(db, budgetId)).pending.keys()];
}

/** The candidate set at run start: how many, and the snapshot's newest row. */
export async function candidateWindow(
  db: Queryable,
  budgetId: string,
  force: boolean,
): Promise<{ count: number; newest: CandidateCursor | null }> {
  const pending = await pendingTransferIds(db, budgetId);
  const args = [budgetId, pending, force, CATEGORIZE_MAX_ATTEMPTS];
  const count = await db.query<{ n: number }>(
    `select count(*)::int as n ${CANDIDATE_FROM} ${CANDIDATE_WHERE}`,
    args,
  );
  const newest = await db.query<CandidateCursor>(
    `select t.date::text as date, t.id::text as id
       ${CANDIDATE_FROM}
       ${CANDIDATE_WHERE}
      order by t.date desc, t.id desc
      limit 1`,
    args,
  );
  return { count: count.rows[0]?.n ?? 0, newest: newest.rows[0] ?? null };
}

/**
 * The next candidate window, walked by a keyset `(date, id)` fixed at run
 * start: rows newer than `snapshot` are never seen by this run and rows
 * inserted or removed mid-run can neither shift the window (offset
 * pagination's double-bill/skip) nor be missed once the cursor passed them.
 */
export async function listCandidates(
  db: Queryable,
  budgetId: string,
  params: { snapshot: CandidateCursor; cursor: CandidateCursor | null; limit: number; force: boolean },
): Promise<Candidate[]> {
  const pending = await pendingTransferIds(db, budgetId);
  const args: unknown[] = [budgetId, pending, params.force, CATEGORIZE_MAX_ATTEMPTS, params.snapshot.date, params.snapshot.id];
  let keyset = '';
  if (params.cursor) {
    args.push(params.cursor.date, params.cursor.id);
    keyset = `and (t.date, t.id) < ($${args.length - 1}::date, $${args.length}::uuid)`;
  }
  args.push(params.limit);
  const { rows } = await db.query<Candidate & { raw_payload: Record<string, unknown> | null }>(
    `select t.id, t.date::text as date, t.amount as amount_milliunits,
            json_build_object('name', a.name, 'type', a.type, 'currency', a.currency) as account,
            coalesce(p.name, t.import_payee_name) as payee, t.payee_id, t.memo,
            null as category,
            ct.raw_payload
       ${CANDIDATE_FROM}
       left join public.connection_transactions ct on ct.transaction_id = t.id and ct.budget_id = t.budget_id
       ${CANDIDATE_WHERE}
        and (t.date, t.id) <= ($5::date, $6::uuid)
        ${keyset}
      order by t.date desc, t.id desc
      limit $${args.length}`,
    args,
  );
  return rows.map(({ raw_payload, ...row }) => ({
    ...row,
    account: { ...row.account, name: cap(row.account.name, MAX_NAME_CHARS) },
    payee: row.payee === null ? null : cap(row.payee),
    memo: row.memo === null ? null : cap(row.memo),
    bank: bankFacts(raw_payload, row.amount_milliunits),
  }));
}

/** One live transaction of the budget, whatever its category state. Null when it is not this budget's. */
export async function getAgentTransaction(db: Queryable, budgetId: string, transactionId: string): Promise<AgentTransaction | null> {
  const { rows } = await db.query<AgentTransaction & { raw_payload: Record<string, unknown> | null }>(
    `select t.id, t.date::text as date, t.amount as amount_milliunits,
            json_build_object('name', a.name, 'type', a.type, 'currency', a.currency) as account,
            coalesce(p.name, t.import_payee_name) as payee, t.payee_id, t.memo,
            case when t.category_id is null then null
                 else json_build_object('id', t.category_id, 'name', c.name) end as category,
            ct.raw_payload
       from public.transactions t
       join public.accounts a on a.id = t.account_id and a.budget_id = t.budget_id
       left join public.payees p on p.id = t.payee_id and p.budget_id = t.budget_id
       left join public.categories c on c.id = t.category_id and c.budget_id = t.budget_id
       left join public.connection_transactions ct on ct.transaction_id = t.id and ct.budget_id = t.budget_id
      where t.id = $2 and t.budget_id = $1 and t.deleted = false`,
    [budgetId, transactionId],
  );
  const row = rows[0];
  if (!row) return null;
  const { raw_payload, ...txn } = row;
  return {
    ...txn,
    account: { ...txn.account, name: cap(txn.account.name, MAX_NAME_CHARS) },
    payee: txn.payee === null ? null : cap(txn.payee),
    memo: txn.memo === null ? null : cap(txn.memo),
    category: txn.category ? { ...txn.category, name: cap(txn.category.name, MAX_NAME_CHARS) } : null,
    bank: bankFacts(raw_payload, txn.amount_milliunits),
  };
}

export type CategoryChoice = { id: string; name: string; note: string | null; group_id: string; group_name: string };

/**
 * The categories a suggestion may name: live, visible, and ASSIGNABLE. The
 * app marks card-payment envelopes and its own internal groups/categories
 * with `is_credit_card_payments` / `internal` (the card-payment setup writes
 * both: api/src/budget/store/accounts.ts); those are never offered to the
 * model and never accepted from an answer, because booking a card payment
 * there would turn the transfer into spending. Hidden/deleted categories are
 * excluded for the same reason.
 */
export async function listCategoryChoices(db: Queryable, budgetId: string): Promise<CategoryChoice[]> {
  const { rows } = await db.query<CategoryChoice>(
    `select c.id, c.name, c.note, g.id as group_id, g.name as group_name
       from public.categories c
       join public.category_groups g on g.id = c.group_id and g.budget_id = c.budget_id
      where c.budget_id = $1
        and c.deleted = false and c.hidden = false and c.internal = false
        and g.deleted = false and g.hidden = false
        and g.is_credit_card_payments = false and g.internal = false
      order by g.sort_order, g.name, c.sort_order, c.name
      limit 200`,
    [budgetId],
  );
  return rows.map((row) => ({
    ...row,
    name: cap(row.name, MAX_NAME_CHARS),
    group_name: cap(row.group_name, MAX_NAME_CHARS),
    note: row.note === null ? null : cap(row.note),
  }));
}

/** How this payee's live transactions were categorized before, most used first. */
export async function payeeHistory(
  db: Queryable,
  budgetId: string,
  payeeId: string,
): Promise<{ category_id: string; category_name: string; transactions: number; last_date: string }[]> {
  const { rows } = await db.query<{ category_id: string; category_name: string; transactions: number; last_date: string }>(
    `select c.id as category_id, c.name as category_name, count(*)::int as transactions,
            max(t.date)::text as last_date
       from public.transactions t
       join public.categories c on c.id = t.category_id and c.budget_id = t.budget_id
      where t.budget_id = $1 and t.payee_id = $2 and t.deleted = false
        and t.category_id is not null
        and c.deleted = false and c.hidden = false
      group by c.id, c.name
      order by transactions desc, last_date desc
      limit 8`,
    [budgetId, payeeId],
  );
  return rows.map((row) => ({ ...row, category_name: cap(row.category_name, MAX_NAME_CHARS) }));
}

export type SimilarTransaction = {
  id: string;
  date: string;
  amount_milliunits: number;
  description: string;
  category_id: string;
  category_name: string;
};

/**
 * Categorized live transactions whose payee/import name/memo contains any of
 * the caller's tokens, best token coverage first. `tokens` are already reduced
 * to [a-z0-9] by the tool, so a `%` can never arrive here. Hidden categories
 * and groups are not evidence the model should learn from.
 */
export async function searchSimilar(
  db: Queryable,
  budgetId: string,
  tokens: readonly string[],
  limit: number,
): Promise<SimilarTransaction[]> {
  if (tokens.length === 0) return [];
  const patterns = tokens.map((token) => `%${token}%`);
  const { rows } = await db.query<SimilarTransaction>(
    `select t.id, t.date::text as date, t.amount as amount_milliunits,
            coalesce(p.name, t.import_payee_name_original, '') as description,
            c.id as category_id, c.name as category_name
       from public.transactions t
       join public.categories c on c.id = t.category_id and c.budget_id = t.budget_id
       join public.category_groups g on g.id = c.group_id and g.budget_id = c.budget_id
       left join public.payees p on p.id = t.payee_id and p.budget_id = t.budget_id
       cross join lateral (
         select coalesce(p.name, '') || ' ' || coalesce(t.import_payee_name_original, '') || ' ' || coalesce(t.memo, '') as haystack
       ) h
      where t.budget_id = $1
        and t.deleted = false
        and t.category_id is not null
        and c.deleted = false and c.hidden = false
        and g.deleted = false and g.hidden = false
        and h.haystack ilike any($2::text[])
      order by (select count(*) from unnest($3::text[]) tok where h.haystack ilike '%' || tok || '%') desc,
               t.date desc, t.id
      limit $4`,
    [budgetId, patterns, [...tokens], limit],
  );
  return rows.map((row) => ({ ...row, description: cap(row.description) }));
}

export type NewSuggestion = {
  categoryId: string;
  confidence: number;
  reason: string | null;
  source: SuggestionSource;
  provider: string | null;
  model: string | null;
};

/** True when the person (or the accept/skip flow) already decided a row of this transaction. */
export async function hasDecidedSuggestion(db: Queryable, transactionId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from public.category_suggestions
      where transaction_id = $1 and status <> 'pending'
      limit 1`,
    [transactionId],
  );
  return rows.length > 0;
}

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
 * budget. `reset` (an explicit re-classify) restarts the attempt counter; a
 * normal attempt increments it. Returns false when the transaction is gone,
 * deleted or already categorized (nothing to record).
 *
 * The fingerprint is computed in SQL from the SAME payee/memo expression the
 * candidate query compares, so "no suggestion" is skipped exactly while the
 * inputs are unchanged.
 */
export async function recordAttempt(
  db: Queryable,
  budgetId: string,
  transactionId: string,
  attempt: { outcome: AttemptOutcome; errorKind: CategorizeFailureKind | null; model: string | null; reset: boolean },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into public.categorize_attempts
       (transaction_id, budget_id, outcome, error_kind, attempts, model, input_fingerprint, last_attempt_at)
     select t.id, t.budget_id, $3, $4, 1, $5, ${ATTEMPT_FINGERPRINT}, now()
       from public.transactions t
       left join public.payees p on p.id = t.payee_id and p.budget_id = t.budget_id
      where t.id = $1 and t.budget_id = $2 and t.deleted = false and t.category_id is null
     on conflict (transaction_id) do update
       set outcome = excluded.outcome,
           error_kind = excluded.error_kind,
           attempts = case when $6::boolean then 1 else public.categorize_attempts.attempts + 1 end,
           model = excluded.model,
           input_fingerprint = excluded.input_fingerprint,
           last_attempt_at = now()`,
    [transactionId, budgetId, attempt.outcome, attempt.errorKind, attempt.model, attempt.reset],
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
 * Replace one transaction's suggestion set atomically, and only while the
 * transaction is still live, uncategorized and in this budget: the row lock
 * makes a concurrent categorization win (then nothing is written).
 *
 * A transaction with ANY decided row (accepted or dismissed) is left alone:
 * the person already answered it, so no new suggestion may overwrite a decided
 * one at its rank, hide it behind a pending row, or resurrect a category they
 * dismissed. Callers skip such transactions too (`CANDIDATE_WHERE`); this is
 * the last line of defence. Ranks above the new answer are dropped while
 * pending only. Returns false when nothing was written.
 */
export async function replaceSuggestions(
  pool: Pool,
  budgetId: string,
  transactionId: string,
  suggestions: readonly NewSuggestion[],
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query(
      'select 1 from public.transactions where id = $1 and budget_id = $2 and category_id is null and deleted = false for update',
      [transactionId, budgetId],
    );
    if (locked.rowCount === 0) return false;
    const decided = await client.query(
      `select 1 from public.categorize_decisions
        where transaction_id = $1 and budget_id = $2 limit 1`,
      [transactionId, budgetId],
    );
    if ((decided.rowCount ?? 0) > 0) return false;
    const existing = await client.query<{ status: string }>(
      'select status from public.category_suggestions where transaction_id = $1 and budget_id = $2',
      [transactionId, budgetId],
    );
    if (existing.rows.some((row) => row.status !== 'pending')) return false;
    for (const [index, suggestion] of suggestions.entries()) {
      await client.query(
        `insert into public.category_suggestions
           (transaction_id, budget_id, rank, category_id, confidence, reason, source, provider, model)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (transaction_id, rank) do update
           set category_id = excluded.category_id, confidence = excluded.confidence,
               reason = excluded.reason, source = excluded.source,
               provider = excluded.provider, model = excluded.model, updated_at = now()
           where public.category_suggestions.status = 'pending'`,
        [
          transactionId,
          budgetId,
          index + 1,
          suggestion.categoryId,
          suggestion.confidence,
          suggestion.reason,
          suggestion.source,
          suggestion.provider,
          suggestion.model,
        ],
      );
    }
    await client.query(
      `delete from public.category_suggestions
        where transaction_id = $1 and rank > $2 and status = 'pending'`,
      [transactionId, suggestions.length],
    );
    return true;
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
  // (The model never calls this; its reads are capped in listCandidates /
  // getAgentTransaction / the tools.)
  return {
    rows: rows.map(({ raw_payload, ...row }) => ({
      ...row,
      bank: userBankFacts(raw_payload, row.amount_milliunits),
    })),
    total: total.rows[0]?.n ?? 0,
  };
}

/**
 * Persist a run's progress so categorize_run_status can poll it without
 * talking to Temporal. Written by the prepare activity (total, done 0) and by
 * the chunk activity as it advances; `done` only grows. The row dies with its
 * job run (foreign key cascade).
 */
export async function recordRunProgress(
  db: Queryable,
  runId: string,
  budgetId: string,
  done: number,
  total: number,
): Promise<void> {
  await db.query(
    `insert into public.categorize_run_progress (run_id, budget_id, done, total)
     values ($1, $2, $3, $4)
     on conflict (run_id) do update
       set budget_id = excluded.budget_id,
           done = greatest(public.categorize_run_progress.done, excluded.done),
           total = greatest(public.categorize_run_progress.total, excluded.total),
           updated_at = now()`,
    [runId, budgetId, done, total],
  );
}

/** The last recorded progress of a run, or null before its prepare activity. */
export async function readRunProgress(
  db: Queryable,
  runId: string,
): Promise<{ done: number; total: number } | null> {
  const { rows } = await db.query<{ done: number; total: number }>(
    'select done, total from public.categorize_run_progress where run_id = $1',
    [runId],
  );
  return rows[0] ?? null;
}
