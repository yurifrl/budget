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
  amount_milliunits: number;
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
  payee_id: string | null;
  payee: string;
  count: number;
  total_milliunits: number;
  first_date: string;
  last_date: string;
  suggestion: QueueSuggestion;
  transaction_ids: string[];
};

export type QueueCounts = {
  left_to_categorize: number;
  above_threshold: number;
  no_suggestion: number;
};

export type QueuePage = { rows: QueueRow[]; counts: QueueCounts; bundles: QueueBundle[] };

/** A category a suggestion may name (same rule as store.listCategoryChoices). */
const ASSIGNABLE = `
  c.deleted = false and c.hidden = false and c.internal = false
  and g.deleted = false and g.hidden = false
  and g.is_credit_card_payments = false and g.internal = false`;

/**
 * The queue: live transactions of this budget that the shared rule says need a
 * category, minus the ones a person already decided (accepted ⇒ categorized;
 * dismissed ⇒ skipped and frozen; both must leave the queue). Args: $1 budget,
 * $2 pending transfer ids. The threshold is $3 in every query that uses this
 * CTE; the page's limit/offset are $4/$5.
 */
const QUEUE_CTE = `with q as (
  select t.id as transaction_id, t.date::text as date, t.amount as amount_milliunits,
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

type RawQueueRow = Omit<QueueRow, 'state' | 'merchant' | 'raw_bank_description'> & {
  suggestions: QueueSuggestion[];
  has_pending: boolean;
  attempt_outcome: string | null;
  raw_payload: Record<string, unknown> | null;
};

function stateOf(row: RawQueueRow): QueueState {
  if (row.suggestions.length > 0) return 'has_suggestions';
  if (row.has_pending) return 'below_threshold';
  switch (row.attempt_outcome) {
    case 'no_suggestion':
      return 'no_suggestion';
    case 'failed':
      return 'failed';
    // 'suggested' with nothing visible: its categories were hidden/deleted.
    case 'suggested':
      return 'below_threshold';
    default:
      return 'not_classified';
  }
}

async function thresholdOf(db: Queryable, budgetId: string): Promise<number> {
  const { rows } = await db.query<{ confidence_threshold: number }>(
    'select confidence_threshold from public.categorize_settings where budget_id = $1',
    [budgetId],
  );
  return rows[0]?.confidence_threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
}

/**
 * One page of the queue, plus counts and bundles computed over the WHOLE
 * queue (never just the page). The threshold is read at call time, so a change
 * applies to the very next read without a re-run.
 */
export async function listQueue(
  db: Queryable,
  budgetId: string,
  options: { limit: number; offset: number },
): Promise<QueuePage> {
  const pending = await pendingTransferIds(db, budgetId);
  const threshold = await thresholdOf(db, budgetId);
  const scope = [budgetId, pending, threshold];

  const { rows } = await db.query<RawQueueRow>(
    `${QUEUE_CTE}
     select q.transaction_id, q.date, q.amount_milliunits, q.account_id, q.account_name,
            q.payee_id, q.payee, q.memo, q.raw_payload,
            ${SUGGESTIONS_JSON} as suggestions,
            exists (
              select 1 from public.category_suggestions b
               where b.transaction_id = q.transaction_id and b.status = 'pending'
            ) as has_pending,
            ca.outcome as attempt_outcome
       from q
       left join public.categorize_attempts ca
              on ca.transaction_id = q.transaction_id and ca.budget_id = $1
      order by q.date desc, q.transaction_id desc
      limit $4 offset $5`,
    [...scope, options.limit, options.offset],
  );

  const counts = await db.query<{ left_to_categorize: number; above_threshold: number }>(
    `${QUEUE_CTE},
     qualified as (
       select exists (
         select 1 from public.category_suggestions s
           join public.categories c on c.id = s.category_id and c.budget_id = $1
           join public.category_groups g on g.id = c.group_id and g.budget_id = $1
          where s.transaction_id = q.transaction_id and s.status = 'pending'
            and s.confidence >= $3 and ${ASSIGNABLE}
       ) as above
         from q
     )
     select count(*)::int as left_to_categorize,
            count(*) filter (where above)::int as above_threshold
       from qualified`,
    scope,
  );
  const left = counts.rows[0]?.left_to_categorize ?? 0;
  const above = counts.rows[0]?.above_threshold ?? 0;

  const bundles = await db.query<{
    payee_id: string | null;
    payee: string;
    category_id: string;
    category_name: string;
    confidence: number;
    reason: string | null;
    source: SuggestionSource;
    count: number;
    total_milliunits: number;
    first_date: string;
    last_date: string;
    transaction_ids: string[];
  }>(
    `${QUEUE_CTE},
     top as (
       select q.transaction_id, q.payee_id, q.payee, q.date, q.amount,
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
     )
     select payee_id, payee, category_id, category_name,
            max(confidence) as confidence,
            (array_agg(reason order by confidence desc, date desc, transaction_id))[1] as reason,
            (array_agg(source order by confidence desc, date desc, transaction_id))[1] as source,
            count(*)::int as count,
            sum(amount)::int as total_milliunits,
            min(date)::text as first_date,
            max(date)::text as last_date,
            array_agg(transaction_id order by date desc, transaction_id desc) as transaction_ids
       from top
      where payee is not null
      group by payee_id, payee, category_id, category_name
      order by count(*) desc, payee, category_name`,
    scope,
  );

  return {
    rows: rows.map(({ raw_payload, has_pending, attempt_outcome, ...row }) => {
      const bank = merchantPanel(raw_payload, row.amount_milliunits);
      return {
        ...row,
        raw_bank_description: bank.raw_bank_description,
        merchant: bank.merchant,
        state: stateOf({ ...row, has_pending, attempt_outcome, raw_payload }),
      };
    }),
    counts: { left_to_categorize: left, above_threshold: above, no_suggestion: left - above },
    bundles: bundles.rows.map((bundle) => ({
      payee_id: bundle.payee_id,
      payee: bundle.payee,
      count: bundle.count,
      total_milliunits: bundle.total_milliunits,
      first_date: bundle.first_date,
      last_date: bundle.last_date,
      suggestion: {
        category_id: bundle.category_id,
        category_name: bundle.category_name,
        confidence: bundle.confidence,
        reason: bundle.reason,
        source: bundle.source,
      },
      transaction_ids: bundle.transaction_ids,
    })),
  };
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
