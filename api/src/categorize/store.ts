/**
 * Categorize store: every SQL statement of the feature. Each function that
 * returns budget data takes the `budgetId` and puts it in the WHERE clause —
 * the model's tools are scoped by construction, never by post-filtering.
 *
 * The only table this feature writes besides its own is none: suggestions go
 * to `category_suggestions`; `transactions.category_id` is read, never written.
 */
import type { Pool } from 'pg';

import type { Queryable } from '../core/db';
import { withTransaction } from '../core/db';
import { HttpError } from '../core/validate';

/** Where a suggestion came from. 'payee_rule' answers first; 'ai' is the model. */
export type SuggestionSource = 'payee_rule' | 'ai';
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed';

/** Bank facts worth showing the model, whitelisted from the provider payload. */
export type BankFacts = {
  description_raw?: string;
  category?: string;
  category_id?: string;
  operation_type?: string;
  status?: string;
  type?: string;
  merchant?: { name?: string; business_name?: string; category?: string; cnae?: string };
  payment?: { method?: string; reason?: string; payer_name?: string; receiver_name?: string };
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
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;

/**
 * The provider payload is reduced to facts a classifier may use. Deliberately
 * dropped: participant document numbers, bank branch/account/routing numbers,
 * payment reference ids and boleto lines — they are personal or bank
 * identifiers, not evidence about the category, and this text leaves the
 * server for a third-party model.
 */
export function bankFacts(raw: Record<string, unknown> | null): BankFacts | null {
  if (!raw) return null;
  const merchant = record(raw.merchant);
  const payment = record(raw.paymentData);
  const card = record(raw.creditCardMetadata);
  const facts: BankFacts = {
    description_raw: text(raw.descriptionRaw),
    category: text(raw.category),
    category_id: text(raw.categoryId),
    operation_type: text(raw.operationType),
    status: text(raw.status),
    type: text(raw.type),
    merchant: merchant
      ? {
          name: text(merchant.name),
          business_name: text(merchant.businessName),
          category: text(merchant.category),
          cnae: text(merchant.cnae),
        }
      : undefined,
    payment: payment
      ? {
          method: text(payment.paymentMethod),
          reason: text(payment.reason),
          payer_name: text(record(payment.payer)?.name),
          receiver_name: text(record(payment.receiver)?.name),
        }
      : undefined,
    card: card
      ? {
          installment_number: int(card.installmentNumber),
          total_installments: int(card.totalInstallments),
          payee_mcc: int(card.payeeMCC),
          purchase_date: text(card.purchaseDate)?.slice(0, 10),
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
 * The app's "this transaction still needs a category" rule, in SQL. It mirrors
 * `client/src/domain/register.ts` (`registerCategoryCell`, lines 20-37) and
 * the facts the register screen scopes by; `candidates.test.ts` imports that
 * client function and fails on any divergence for the cases it can express.
 *
 * Excluded here: inflows (money in goes to Ready to Assign), rows on
 * off-budget/tracking or closed or deleted accounts, split parents, upcoming
 * occurrences, linked transfers, rows a transfer mark or a transfer payee
 * covers, reconciliation/balance adjustments, and after a first run —
 * transactions that already have suggestions (unless `force`).
 *
 * `$2` is `force`.
 */
const CANDIDATE_FROM = `
  from public.transactions t
  join public.accounts a on a.id = t.account_id and a.budget_id = t.budget_id
  left join public.payees p on p.id = t.payee_id and p.budget_id = t.budget_id
  left join public.connection_transactions ct on ct.transaction_id = t.id and ct.budget_id = t.budget_id`;

const CANDIDATE_WHERE = `
  where t.budget_id = $1
    and t.deleted = false
    and t.category_id is null
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
    and not exists (
      select 1 from public.transfer_marks m
       where m.transaction_id = t.id and m.state <> 'dismissed'
    )
    and not exists (
      select 1 from public.payees pr
       where pr.id = t.payee_id
         and pr.transfer_rule in ('auto', 'account')
         and (pr.transfer_rule_since is null or t.created_at >= pr.transfer_rule_since)
         and (
           (current_date - t.date) <= pr.transfer_rule_wait_days
           or pr.transfer_rule_no_match = 'outside'
         )
    )
    and not exists (select 1 from public.subtransactions s where s.transaction_id = t.id and s.deleted = false)
    and ($2::boolean or not exists (select 1 from public.category_suggestions cs where cs.transaction_id = t.id))`;

/** The candidate set at run start: how many, and the snapshot's newest row. */
export async function candidateWindow(
  db: Queryable,
  budgetId: string,
  force: boolean,
): Promise<{ count: number; newest: CandidateCursor | null }> {
  const count = await db.query<{ n: number }>(
    `select count(*)::int as n ${CANDIDATE_FROM} ${CANDIDATE_WHERE}`,
    [budgetId, force],
  );
  const newest = await db.query<CandidateCursor>(
    `select t.date::text as date, t.id::text as id
       ${CANDIDATE_FROM}
       ${CANDIDATE_WHERE}
      order by t.date desc, t.id desc
      limit 1`,
    [budgetId, force],
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
  const args: unknown[] = [budgetId, params.force, params.snapshot.date, params.snapshot.id];
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
       ${CANDIDATE_WHERE}
        and (t.date, t.id) <= ($3::date, $4::uuid)
        ${keyset}
      order by t.date desc, t.id desc
      limit $${args.length}`,
    args,
  );
  return rows.map(({ raw_payload, ...row }) => ({ ...row, bank: bankFacts(raw_payload) }));
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
  return { ...txn, bank: bankFacts(raw_payload) };
}

export type CategoryChoice = { id: string; name: string; note: string | null; group_id: string; group_name: string };

/**
 * The categories a suggestion may name: live, not hidden, in a live visible
 * group. Hidden/deleted categories are never offered and ids outside this set
 * are dropped from model answers.
 */
export async function listCategoryChoices(db: Queryable, budgetId: string): Promise<CategoryChoice[]> {
  const { rows } = await db.query<CategoryChoice>(
    `select c.id, c.name, c.note, g.id as group_id, g.name as group_name
       from public.categories c
       join public.category_groups g on g.id = c.group_id and g.budget_id = c.budget_id
      where c.budget_id = $1
        and c.deleted = false and c.hidden = false
        and g.deleted = false and g.hidden = false
      order by g.sort_order, g.name, c.sort_order, c.name`,
    [budgetId],
  );
  return rows;
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
  return rows;
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
  return rows;
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
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Suggestions the page may show: pending by default, at/above the threshold,
 * for live uncategorized transactions of this budget only (a transaction
 * categorized by hand after the run drops out of the queue). Hidden/deleted
 * categories and groups and deleted accounts are filtered here as well as at
 * write time, so an old row can never surface through a later hide.
 *
 * The caller (the HTTP layer) checks budget ACCESS: this query is scoped by
 * `budgetId` only. A non-uuid `transactionId` is a validation error, not a
 * driver error, because callers pass it through from a path parameter.
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
    left join public.payees p on p.id = t.payee_id and p.budget_id = s.budget_id`;
  const where = `s.budget_id = $1 and s.status = $2 and s.confidence >= $3
    and t.deleted = false and t.category_id is null
    and c.deleted = false and c.hidden = false
    and g.deleted = false and g.hidden = false
    and a.deleted = false
    ${options.transactionId ? 'and s.transaction_id = $4' : ''}`;
  const args: unknown[] = [budgetId, options.status ?? 'pending', options.minConfidence];
  if (options.transactionId) args.push(options.transactionId);
  const limitAt = args.length + 1;
  const offsetAt = args.length + 2;
  const total = await db.query<{ n: number }>(`select count(*)::int as n ${from} where ${where}`, args);
  const { rows } = await db.query<SuggestionRow>(
    `select s.transaction_id, s.rank, s.category_id, c.name as category_name,
            g.id as group_id, g.name as group_name,
            s.confidence, s.reason, s.source, s.provider, s.model, s.status,
            t.date::text as date, t.amount as amount_milliunits,
            coalesce(p.name, t.import_payee_name) as payee,
            t.account_id, a.name as account_name, t.memo
       ${from}
      where ${where}
      order by t.date desc, t.id, s.rank
      limit $${limitAt} offset $${offsetAt}`,
    [...args, options.limit, options.offset],
  );
  return { rows, total: total.rows[0]?.n ?? 0 };
}
