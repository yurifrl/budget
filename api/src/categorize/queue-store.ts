/**
 * SQL for the Categorize PAGE (queue, bundles, threshold). Separate from
 * store.ts, which is model-facing: these reads return the owner's own text and
 * bank data exactly as stored, because the person is looking at their own
 * transactions. Masking/length caps exist only on the prompt side.
 *
 * Every query is scoped by budget_id in SQL and shares the register's
 * "needs a category" rule with the run (NEEDS_CATEGORY_FROM/WHERE in store.ts,
 * plus the transfer-plan ids) — the queue does not re-state that rule.
 */
import type { Queryable } from '../core/db';
import { merchantPanel, NEEDS_CATEGORY_FROM, NEEDS_CATEGORY_WHERE, pendingTransferIds, type SuggestionSource } from './store';
import type { MerchantPanel } from './store';

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

export type QueueSuggestion = {
  category_id: string;
  category_name: string;
  confidence: number;
  reason: string | null;
  source: SuggestionSource;
};

export type QueueState = 'has_suggestions' | 'below_threshold' | 'no_suggestion' | 'failed' | 'not_classified';

export type QueueRow = {
  transaction_id: string;
  date: string;
  /** Signed integer milliunits; an outflow is negative. */
  amount: number;
  account_id: string;
  account_name: string;
  payee_id: string | null;
  payee: string | null;
  memo: string | null;
  raw_bank_description: string | null;
  merchant: MerchantPanel | null;
  state: QueueState;
  suggestions: QueueSuggestion[];
};

export type QueueBundle = {
  /** Opaque key: pass it back as the queue `bundle` filter or to accept. */
  bundle_key: string;
  payee_id: string | null;
  payee: string;
  count: number;
  /** Signed integer milliunits: the sum of the bundle's transactions. */
  total: number;
  first_date: string;
  last_date: string;
  suggestion: QueueSuggestion;
};

/** The decoded bundle key. The category is the bundle's top suggestion. */
export type BundleKey = { payee_id: string | null; payee: string; category_id: string };

export type QueueCounts = {
  left_to_categorize: number;
  above_threshold: number;
  has_suggestions: number;
  below_threshold: number;
  no_suggestion: number;
  failed: number;
  not_classified: number;
};

export type QueuePage = { rows: QueueRow[]; counts: QueueCounts; bundles: QueueBundle[] };

/** A category a suggestion may name (same rule as store.listCategoryChoices). */
const ASSIGNABLE = `
  c.deleted = false and c.hidden = false and c.internal = false
  and g.deleted = false and g.hidden = false
  and g.is_credit_card_payments = false and g.internal = false`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A deterministic, URL-safe key for one bundle (payee + top suggestion). */
export function encodeBundleKey(key: BundleKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** The decoded key, or null when the text is not one this server issued. */
export function decodeBundleKey(value: string): BundleKey | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<BundleKey> | null;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (parsed.payee_id !== null && (typeof parsed.payee_id !== 'string' || !UUID_RE.test(parsed.payee_id))) return null;
    if (typeof parsed.payee !== 'string' || parsed.payee.length === 0 || parsed.payee.length > 500) return null;
    if (typeof parsed.category_id !== 'string' || !UUID_RE.test(parsed.category_id)) return null;
    return { payee_id: parsed.payee_id, payee: parsed.payee, category_id: parsed.category_id };
  } catch {
    return null;
  }
}

/**
 * The queue: live transactions of this budget that the shared rule says need a
 * category, minus the ones a person already decided (accepted ⇒ categorized;
 * skipped ⇒ a skip decision; both must leave the queue). Args: $1 budget,
 * $2 pending transfer ids. The threshold is $3 in every query that uses this
 * CTE; the page's limit/offset are the last two args.
 */
const QUEUE_CTE = `with q as (
  select t.id as transaction_id, t.date::text as date, t.amount as amount,
         t.account_id, a.name as account_name,
         t.payee_id, coalesce(p.name, t.import_payee_name) as payee, t.memo,
         ct.raw_payload
    ${NEEDS_CATEGORY_FROM}
    left join public.connection_transactions ct on ct.transaction_id = t.id and ct.budget_id = t.budget_id
   ${NEEDS_CATEGORY_WHERE}
     and not exists (
       select 1 from public.category_suggestions ds
        where ds.transaction_id = t.id and ds.status <> 'pending'
     )
     and not exists (
       select 1 from public.categorize_decisions cd
        where cd.transaction_id = t.id and cd.budget_id = t.budget_id
     )
)`;

/** The visible suggestion set of one queue row, best rank first (JSON). */
const SUGGESTIONS_JSON = `(
  select coalesce(json_agg(json_build_object(
           'category_id', s.category_id,
           'category_name', c.name,
           'confidence', s.confidence,
           'reason', s.reason,
           'source', s.source
         ) order by s.rank), '[]'::json)
    from public.category_suggestions s
    join public.categories c on c.id = s.category_id and c.budget_id = $1
    join public.category_groups g on g.id = c.group_id and g.budget_id = $1
   where s.transaction_id = q.transaction_id and s.status = 'pending' and s.confidence >= $3
     and ${ASSIGNABLE}
)`;

/** At least one visible pending suggestion, whatever its confidence. */
const HAS_VISIBLE = `exists (
  select 1 from public.category_suggestions b
    join public.categories c on c.id = b.category_id and c.budget_id = $1
    join public.category_groups g on g.id = c.group_id and g.budget_id = $1
   where b.transaction_id = q.transaction_id and b.status = 'pending'
     and ${ASSIGNABLE}
)`;

/** Any pending suggestion, even one whose category is not usable. */
const HAS_ANY = `exists (
  select 1 from public.category_suggestions b
   where b.transaction_id = q.transaction_id and b.status = 'pending'
)`;

/** At least one visible pending suggestion at/above the threshold. */
const HAS_ABOVE = `exists (
  select 1 from public.category_suggestions s
    join public.categories c on c.id = s.category_id and c.budget_id = $1
    join public.category_groups g on g.id = c.group_id and g.budget_id = $1
   where s.transaction_id = q.transaction_id and s.status = 'pending'
     and s.confidence >= $3 and ${ASSIGNABLE}
)`;

/** The top visible suggestion of each queue row (the bundle's grouping key). */
const TOP_CTE = `${QUEUE_CTE}, top as (
  select q.transaction_id, q.payee_id, q.payee, q.date, q.amount as amount,
         s.category_id, s.category_name, s.confidence, s.reason, s.source
    from q
    cross join lateral (
      select s.category_id, c.name as category_name, s.confidence, s.reason, s.source
        from public.category_suggestions s
        join public.categories c on c.id = s.category_id and c.budget_id = $1
        join public.category_groups g on g.id = c.group_id and g.budget_id = $1
       where s.transaction_id = q.transaction_id and s.status = 'pending'
         and s.confidence >= $3 and ${ASSIGNABLE}
       order by s.rank
       limit 1
    ) s
)`;

const STATE_SQL = `case
  when ${HAS_ABOVE} then 'has_suggestions'
  when ${HAS_VISIBLE} then 'below_threshold'
  when ${HAS_ANY} then 'no_suggestion'
  when ca.outcome = 'failed' then 'failed'
  when ca.outcome is null then 'not_classified'
  else 'no_suggestion'
end`;

type RawQueueRow = Omit<QueueRow, 'state' | 'merchant' | 'raw_bank_description'> & {
  suggestions: QueueSuggestion[];
  has_pending: boolean;
  has_any_pending: boolean;
  attempt_outcome: string | null;
  raw_payload: Record<string, unknown> | null;
};

function stateOf(row: RawQueueRow): QueueState {
  if (row.suggestions.length > 0) return 'has_suggestions';
  if (row.has_pending) return 'below_threshold';
  // A pending suggestion that is not visible (hidden/deleted category) is a
  // classified row with no usable suggestion, never below_threshold.
  if (row.has_any_pending) return 'no_suggestion';
  switch (row.attempt_outcome) {
    case 'failed':
      return 'failed';
    // 'suggested' with nothing visible (hidden/deleted/uncategorizable
    // categories) is the same as a classified row with no usable suggestion.
    case null:
      return 'not_classified';
    default:
      return 'no_suggestion';
  }
}

async function thresholdOf(db: Queryable, budgetId: string): Promise<number> {
  const { rows } = await db.query<{ confidence_threshold: number }>(
    'select confidence_threshold from public.categorize_settings where budget_id = $1',
    [budgetId],
  );
  return rows[0]?.confidence_threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
}

function countsOf(rows: { state: QueueState; n: number }[]): QueueCounts {
  const counts: QueueCounts = {
    left_to_categorize: 0,
    above_threshold: 0,
    has_suggestions: 0,
    below_threshold: 0,
    no_suggestion: 0,
    failed: 0,
    not_classified: 0,
  };
  for (const row of rows) {
    counts[row.state] = row.n;
    counts.left_to_categorize += row.n;
  }
  counts.above_threshold = counts.has_suggestions;
  return counts;
}

/**
 * One page of the queue, plus counts and bundles computed over the WHOLE
 * queue (never just the page). With a bundle key, the rows are that bundle's
 * rows (still paged); counts and bundles stay whole-queue. The threshold is
 * read at call time, so a change applies to the very next read.
 */
export async function listQueue(
  db: Queryable,
  budgetId: string,
  options: { limit: number; offset: number; bundle?: BundleKey },
): Promise<QueuePage> {
  const pending = await pendingTransferIds(db, budgetId);
  const threshold = await thresholdOf(db, budgetId);
  const scope = [budgetId, pending, threshold];
  const bundle = options.bundle;

  const bundleFilter = bundle
    ? `, filtered as (
         select q.* from q
          where q.payee is not null
            and q.payee_id is not distinct from $4
            and q.payee = $5
            and (
              select s.category_id
                from public.category_suggestions s
                join public.categories c on c.id = s.category_id and c.budget_id = $1
                join public.category_groups g on g.id = c.group_id and g.budget_id = $1
               where s.transaction_id = q.transaction_id and s.status = 'pending'
                 and s.confidence >= $3 and ${ASSIGNABLE}
               order by s.rank
               limit 1
            ) = $6
       )`
    : '';
  const source = bundle ? 'filtered' : 'q';
  const pageParams = bundle ? [...scope, bundle.payee_id, bundle.payee, bundle.category_id] : scope;

  const { rows } = await db.query<RawQueueRow>(
    `${QUEUE_CTE}${bundleFilter}
     select q.transaction_id, q.date, q.amount, q.account_id, q.account_name,
            q.payee_id, q.payee, q.memo, q.raw_payload,
            ${SUGGESTIONS_JSON} as suggestions,
            ${HAS_VISIBLE} as has_pending,
            ${HAS_ANY} as has_any_pending,
            ca.outcome as attempt_outcome
       from ${source} q
       left join public.categorize_attempts ca
              on ca.transaction_id = q.transaction_id and ca.budget_id = $1
      order by q.date desc, q.transaction_id desc
      limit $${pageParams.length + 1} offset $${pageParams.length + 2}`,
    [...pageParams, options.limit, options.offset],
  );

  const counts = await db.query<{ state: QueueState; n: number }>(
    `${QUEUE_CTE},
     qualified as (
       select ${STATE_SQL} as state
         from q
         left join public.categorize_attempts ca
                on ca.transaction_id = q.transaction_id and ca.budget_id = $1
     )
     select state, count(*)::int as n from qualified group by state`,
    scope,
  );

  const bundles = await db.query<{
    payee_id: string | null;
    payee: string;
    category_id: string;
    category_name: string;
    confidence: number;
    reason: string | null;
    source: SuggestionSource;
    count: number;
    total: number;
    first_date: string;
    last_date: string;
  }>(
    `${TOP_CTE}
     select payee_id, payee, category_id, category_name,
            max(confidence) as confidence,
            (array_agg(reason order by confidence desc, date desc, transaction_id))[1] as reason,
            (array_agg(source order by confidence desc, date desc, transaction_id))[1] as source,
            count(*)::int as count,
            sum(amount)::int as total,
            min(date)::text as first_date,
            max(date)::text as last_date
       from top
      where payee is not null
      group by payee_id, payee, category_id, category_name
      order by count(*) desc, payee, category_name`,
    scope,
  );

  return {
    rows: rows.map(({ raw_payload, has_pending, has_any_pending, attempt_outcome, ...row }) => {
      const bank = merchantPanel(raw_payload, row.amount);
      return {
        ...row,
        raw_bank_description: bank.raw_bank_description,
        merchant: bank.merchant,
        state: stateOf({ ...row, has_pending, has_any_pending, attempt_outcome, raw_payload }),
      };
    }),
    counts: countsOf(counts.rows),
    bundles: bundles.rows.map((bundleRow) => ({
      bundle_key: encodeBundleKey({
        payee_id: bundleRow.payee_id,
        payee: bundleRow.payee,
        category_id: bundleRow.category_id,
      }),
      payee_id: bundleRow.payee_id,
      payee: bundleRow.payee,
      count: bundleRow.count,
      total: bundleRow.total,
      first_date: bundleRow.first_date,
      last_date: bundleRow.last_date,
      suggestion: {
        category_id: bundleRow.category_id,
        category_name: bundleRow.category_name,
        confidence: bundleRow.confidence,
        reason: bundleRow.reason,
        source: bundleRow.source,
      },
    })),
  };
}

/**
 * The transaction ids of one bundle, resolved inside the caller's transaction.
 * One extra row is fetched so accept can refuse a bundle above its 1000 cap.
 */
export async function bundleTransactionIds(
  db: Queryable,
  budgetId: string,
  key: BundleKey,
  pending: readonly string[],
): Promise<string[]> {
  const threshold = await thresholdOf(db, budgetId);
  const { rows } = await db.query<{ transaction_id: string }>(
    `${TOP_CTE}
     select transaction_id from top
      where payee_id is not distinct from $4
        and payee = $5
        and category_id = $6
      order by date desc, transaction_id desc
      limit 1001`,
    [budgetId, pending, threshold, key.payee_id, key.payee, key.category_id],
  );
  return rows.map((row) => row.transaction_id);
}

/** The budget's threshold; the default when it never set one. */
export async function getConfidenceThreshold(db: Queryable, budgetId: string): Promise<number> {
  return thresholdOf(db, budgetId);
}

/** Upsert the threshold, returning the stored value. */
export async function setConfidenceThreshold(db: Queryable, budgetId: string, value: number): Promise<number> {
  const { rows } = await db.query<{ confidence_threshold: number }>(
    `insert into public.categorize_settings (budget_id, confidence_threshold)
     values ($1, $2)
     on conflict (budget_id) do update
       set confidence_threshold = excluded.confidence_threshold, updated_at = now()
     returning confidence_threshold`,
    [budgetId, value],
  );
  return rows[0]!.confidence_threshold;
}
