/**
 * Wire schemas of the Categorize page operations. These are the USER-facing
 * shapes: the transaction's own text is returned as stored (no masking, no
 * length cap).
 *
 * Money is integer milliunits (12.34 = 12340), outflows negative. Dates are
 * YYYY-MM-DD strings; timestamps are ISO strings.
 */
import { z } from '../../zod';

import { isoDateSchema, milliunitsSchema, uuidSchema } from '../../validation';

import { jevKeyProblemSchema } from '../jev/outputs';

/** Where a suggestion came from: `payee_rule` (the payee rule), `jev` (the Jev classifier) or `manual` (a person's choice recorded on accept). */
export const categorizeSuggestionSourceSchema = z.enum(['payee_rule', 'jev', 'manual']);

/**
 * What the queue knows about a transaction:
 *  has_suggestions  at least one pending suggestion at/above the threshold
 *  below_threshold  suggestions exist, but none is visible at the threshold
 *  no_suggestion    classified, and the classifier returned no suggestion
 *  failed           the last attempt failed (its kind is not exposed here)
 *  not_classified   no attempt and no suggestion yet
 */
export const categorizeQueueStateSchema = z.enum([
  'has_suggestions',
  'below_threshold',
  'no_suggestion',
  'failed',
  'not_classified',
]);

/**
 * One category suggestion at/above the budget threshold. Jev's transfer answers
 * are read through `categorize_transfers` instead: they name an account, not a
 * category, and the queue shows them in its own section.
 */
export const categorizeSuggestionSchema = z.object({
  category_id: uuidSchema,
  category_name: z.string(),
  /** 0..1 (the payee rule records 1). */
  confidence: z.number().min(0).max(1),
  reason: z.string().nullable(),
  source: categorizeSuggestionSourceSchema,
});

/**
 * The facts the merchant panel shows, exactly as the bank sent them (never
 * masked or truncated). `null` when the transaction is not bank-imported or
 * the provider sent no merchant/payment block.
 */
export const categorizeMerchantPanelSchema = z.object({
  name: z.string().nullable(),
  legal_name: z.string().nullable(),
  cnpj: z.string().nullable(),
  business_category: z.string().nullable(),
  operation_type: z.string().nullable(),
  /** PIX counterparty of THIS row: receiver for money out, payer for money in. */
  counterparty_name: z.string().nullable(),
});

/** One queue row: the transaction, its visible suggestions and its state. */
export const categorizeQueueRowSchema = z.object({
  transaction_id: uuidSchema,
  date: isoDateSchema,
  /** Integer milliunits; an outflow is negative. */
  amount: milliunitsSchema,
  account_id: uuidSchema,
  account_name: z.string(),
  payee_id: uuidSchema.nullable(),
  payee: z.string().nullable(),
  memo: z.string().nullable(),
  /** `raw_payload.descriptionRaw` as stored, unmasked and untruncated. */
  raw_bank_description: z.string().nullable(),
  merchant: categorizeMerchantPanelSchema.nullable(),
  state: categorizeQueueStateSchema,
  /** Pending suggestions at/above the budget threshold, best rank first. */
  suggestions: z.array(categorizeSuggestionSchema),
});

/**
 * Transactions with the same payee and the same top suggestion, aggregated over
 * the WHOLE queue (not the requested page). `bundle_key` fetches the bundle's
 * rows through the queue's `bundle` filter and is what accept takes; the bundle
 * itself carries no transaction ids.
 */
export const categorizeBundleSchema = z.object({
  bundle_key: z.string(),
  payee_id: uuidSchema.nullable(),
  payee: z.string(),
  count: z.number().int().positive(),
  /** Integer milliunits: the sum of the bundle's transactions. */
  total: milliunitsSchema,
  first_date: isoDateSchema,
  last_date: isoDateSchema,
  suggestion: categorizeSuggestionSchema,
});

/**
 * One count per row state; `no_suggestion` counts exactly the rows whose state
 * is `no_suggestion` (a usable visible suggestion is required for
 * below_threshold, so a pending suggestion on a now-hidden category does not
 * count there). The five states sum to `left_to_categorize`.
 */
export const categorizeQueueCountsSchema = z.object({
  /** Rows the queue holds now (all states). */
  left_to_categorize: z.number().int().min(0),
  /** Rows with at least one visible suggestion at/above the threshold. */
  above_threshold: z.number().int().min(0),
  has_suggestions: z.number().int().min(0),
  below_threshold: z.number().int().min(0),
  no_suggestion: z.number().int().min(0),
  failed: z.number().int().min(0),
  not_classified: z.number().int().min(0),
});

export const categorizeQueueSchema = z.object({
  rows: z.array(categorizeQueueRowSchema),
  counts: categorizeQueueCountsSchema,
  bundles: z.array(categorizeBundleSchema),
});

/** One row of a transfer group: the transaction Jev judged to be a transfer. */
export const categorizeTransferRowSchema = z.object({
  transaction_id: uuidSchema,
  date: isoDateSchema,
  /** Integer milliunits; an outflow is negative. */
  amount: milliunitsSchema,
  /** The transaction's own account. */
  account_id: uuidSchema,
  account_name: z.string(),
  payee_id: uuidSchema.nullable(),
  payee: z.string(),
  /** 0..1. */
  confidence: z.number().min(0).max(1),
});

/**
 * Jev's transfer suggestions for one account pair: which way the money moved
 * (`to` the transfer account on an outflow, `from` it on an inflow), whether that
 * account is on budget, and the rows that would become transfers.
 */
export const categorizeTransferGroupSchema = z.object({
  transfer_account_id: uuidSchema,
  transfer_account_name: z.string(),
  direction: z.enum(['to', 'from']),
  on_budget: z.boolean(),
  /** Sum of the group's amounts, integer milliunits. */
  total: milliunitsSchema,
  rows: z.array(categorizeTransferRowSchema),
});

export const categorizeTransferSuggestionsSchema = z.object({
  groups: z.array(categorizeTransferGroupSchema),
});

export type CategorizeTransferSuggestions = z.infer<typeof categorizeTransferSuggestionsSchema>;

/** One account-pair group of Jev's transfer suggestions. */
export type CategorizeTransferGroup = CategorizeTransferSuggestions['groups'][number];

/**
 * One accepted target; the same pair undoes it. A category (`category_id`) or a
 * transfer to one of the budget's accounts (`transfer_account_id`) — exactly one
 * of the two, since a transfer between own accounts carries no category.
 */
export const categorizeDecisionItemSchema = z
  .object({
    transaction_id: uuidSchema,
    category_id: uuidSchema.nullable().optional(),
    transfer_account_id: uuidSchema.nullable().optional(),
  })
  .refine((item) => (item.category_id ?? null) !== null || (item.transfer_account_id ?? null) !== null, {
    message: 'a decision names a category or a transfer account',
  })
  .refine((item) => (item.category_id ?? null) === null || (item.transfer_account_id ?? null) === null, {
    message: 'a decision names a category or a transfer account, not both',
  });

export const categorizeAcceptResultSchema = z.object({
  accepted: z.number().int().min(0),
  /** Exactly what was applied; pass it back to categorize_undo. */
  items: z.array(categorizeDecisionItemSchema),
});

/**
 * Why undo left a transaction alone: no accept record (never accepted, or
 * already undone), its category changed since the accept, it is an upcoming
 * repeat occurrence, or it is gone.
 */
export const categorizeUndoSkipReasonSchema = z.enum(['no_decision', 'category_changed', 'upcoming', 'skipped', 'not_found']);

export const categorizeUndoSkipSchema = z.object({
  transaction_id: uuidSchema,
  reason: categorizeUndoSkipReasonSchema,
});

export const categorizeUndoResultSchema = z.object({
  restored: z.number().int().min(0),
  transaction_ids: z.array(uuidSchema),
  /** Everything undo did not reverse, with the reason. */
  skipped: z.array(categorizeUndoSkipSchema),
});

export const categorizeSkipResultSchema = z.object({
  /** Suggestions moved to dismissed (0 on a repeated skip). */
  dismissed: z.number().int().min(0),
});

export const categorizeTransferRefusalResultSchema = z.object({
  /** The answer is on record (a repeat answers true again). */
  refused: z.boolean(),
  /** Transfer suggestions removed from the row (0 on a repeated answer). */
  dismissed: z.number().int().min(0),
});

export const categorizeSettingsSchema = z.object({
  budget_id: uuidSchema,
  /** Suggestions below this confidence are hidden from the queue. 0..1. */
  confidence_threshold: z.number().min(0).max(1),
});

/**
 * Why a run stopped before it could finish, one code per cause the page can
 * tell apart: no key could be resolved for the budget, Jev refused the key,
 * the account has no credits, Jev was unavailable (rate limit, outage,
 * timeout, network), the budget has no category to suggest from or more than
 * Jev accepts, or the run itself broke. The page shows one sentence per code.
 */
export const categorizeRunFailureSchema = z.enum([
  /** Jev refused the key: check it in OpenRouter and save it again. */
  'key_rejected',
  /** The OpenRouter account behind the key has no credits left. */
  'no_credits',
  /** Jev was unreachable, rate limited, or answered 5xx/timeout repeatedly. */
  'jev_unavailable',
  /** The budget has more categories than one Jev question accepts. */
  'too_many_categories',
  /** The budget has no category a suggestion may name. */
  'no_categories',
  /** No key can be used for this budget (none saved, feature off, no shared key, unreadable). */
  'not_configured',
  /** Anything else that ended the run early. */
  'internal',
]);

export type CategorizeRunFailure = z.infer<typeof categorizeRunFailureSchema>;

/**
 * The safety rate limit, NOT a run size: one budget may send at most this many
 * transactions to Jev per rolling hour, across every run. A run itself has no
 * size cap — the person chooses how many it takes, and the hour trims it. It
 * protects the person's credits from a runaway loop; it is stated once here and
 * both the API and the page take the number from this constant.
 */
export const CATEGORIZE_HOURLY_LIMIT = 5000;

/**
 * The Categorize run, as the page shows it: whether a key is available, what a
 * run started now would send, and the state of the run in flight (or the most
 * recent one). `running`/`queued` come from the jobs ledger; done/total/
 * failures from the run's own progress row.
 */
export const categorizeRunStatusSchema = z.object({
  budget_id: uuidSchema,
  /** A Jev key can be used for this budget right now (own, or the shared one). */
  configured: z.boolean(),
  /**
   * Transactions waiting for a Jev question right now, uncapped: the run's own
   * candidate rule with no allowance applied (outflows that need a category and
   * the inflows of a possible transfer). The run-size input and the empty state
   * read this, never the queue's size (the queue also shows rows that already
   * carry suggestions).
   */
  waiting: z.number().int().min(0),
  /**
   * What a run started in this moment would send: `waiting` trimmed by the
   * hour's free allowance. The confirmation counts this, and 0 disables the
   * button.
   */
  candidates: z.number().int().min(0),
  /** Why no key can be used; null when one can. */
  reason: jevKeyProblemSchema.nullable(),
  /**
   * The rolling hour's sending allowance, so the page can wait instead of
   * promising a run the API will refuse.
   */
  hourly: z.object({
    limit: z.number().int().min(0),
    used: z.number().int().min(0),
    /** Minutes until the hour frees a slot; null when nothing was sent lately. */
    frees_in_minutes: z.number().int().min(0).nullable(),
  }),
  /** The run in flight, or the most recent one; null when this budget never ran. */
  run: z
    .object({
      run_id: uuidSchema,
      state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
      /** Transactions the run took in. */
      total: z.number().int().min(0),
      /** Transactions it answered or skipped so far. */
      done: z.number().int().min(0),
      /** Transactions whose call failed (they stay candidates for a later run). */
      failures: z.number().int().min(0),
      /** Why the run stopped, when it did not finish on its own; null otherwise. */
      failure: categorizeRunFailureSchema.nullable(),
      started_at: z.string(),
    })
    .nullable(),
});

export type CategorizeRunStatus = z.infer<typeof categorizeRunStatusSchema>;
