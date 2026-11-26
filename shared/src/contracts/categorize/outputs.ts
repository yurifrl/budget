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

/** One suggestion at/above the budget threshold. */
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

/** One accepted category; the same pair undoes it. */
export const categorizeDecisionItemSchema = z.object({
  transaction_id: uuidSchema,
  category_id: uuidSchema,
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
 * How many transactions one run asks about. The page shows the confirmation,
 * the disabled state and the empty state from it, so it is stated once here
 * and the API takes it from this constant.
 */
export const CATEGORIZE_RUN_LIMIT = 100;

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
   * Rows a run started now would ask about: the run's own candidate rule,
   * capped at {@link CATEGORIZE_RUN_LIMIT}. This is what the confirmation
   * counts and what the empty state means, not the queue's size (the queue
   * also shows rows that already have suggestions).
   */
  candidates: z.number().int().min(0),
  /** Why no key can be used; null when one can. */
  reason: jevKeyProblemSchema.nullable(),
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
