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

/** Where a suggestion came from. `manual` is a person's choice recorded on accept. */
export const categorizeSuggestionSourceSchema = z.enum(['payee_rule', 'ai', 'manual']);

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
