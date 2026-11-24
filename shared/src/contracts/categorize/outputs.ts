/**
 * Wire schemas of the Categorize page operations. These are the USER-facing
 * shapes: the transaction's own text is returned as stored (no masking, no
 * length cap). Masking and caps exist only on the model-facing reads in
 * api/src/categorize/store.ts.
 *
 * Money is integer milliunits (12.34 = 12340), outflows negative. Dates are
 * YYYY-MM-DD strings; timestamps are ISO strings.
 */
import { z } from '../../zod';

import { isoDateSchema, milliunitsSchema, uuidSchema } from '../../validation';
import { AI_KEY_PROBLEMS, aiProviderSchema } from '../ai/outputs';

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
  /** The model's self-report (the payee rule records 1), 0..1. */
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
  /** Signed integer milliunits; an outflow is negative. */
  amount_milliunits: milliunitsSchema,
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
 * the WHOLE queue (not the requested page). `transaction_ids` is everything an
 * accept of the bundle needs, newest first.
 */
export const categorizeBundleSchema = z.object({
  payee_id: uuidSchema.nullable(),
  payee: z.string(),
  count: z.number().int().positive(),
  /** Signed integer milliunits: the sum of the bundle's transactions. */
  total_milliunits: milliunitsSchema,
  first_date: isoDateSchema,
  last_date: isoDateSchema,
  suggestion: categorizeSuggestionSchema,
  transaction_ids: z.array(uuidSchema).min(1),
});

export const categorizeQueueCountsSchema = z.object({
  /** Rows the queue holds now (all states). */
  left_to_categorize: z.number().int().min(0),
  /** Rows with at least one suggestion at/above the threshold. */
  above_threshold: z.number().int().min(0),
  /**
   * Rows without a suggestion at/above the threshold: below-threshold,
   * classified with no suggestion, failed and not-classified alike.
   */
  no_suggestion: z.number().int().min(0),
});

export const categorizeQueueSchema = z.object({
  rows: z.array(categorizeQueueRowSchema),
  counts: categorizeQueueCountsSchema,
  bundles: z.array(categorizeBundleSchema),
});

export const categorizeRunStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

/** An active run: progress is what the worker last recorded (0/0 while queued). */
export const categorizeActiveRunSchema = z.object({
  id: uuidSchema,
  status: categorizeRunStatusSchema,
  created_at: z.string(),
  started_at: z.string().nullable(),
  requested_by: z.string().nullable(),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
});

/** The last finished run; counts are null when the run produced no result. */
export const categorizeFinishedRunSchema = z.object({
  id: uuidSchema,
  status: categorizeRunStatusSchema,
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  total: z.number().int().min(0).nullable(),
  done: z.number().int().min(0).nullable(),
  suggested: z.number().int().min(0).nullable(),
  rule: z.number().int().min(0).nullable(),
  empty: z.number().int().min(0).nullable(),
  skipped: z.number().int().min(0).nullable(),
  failed: z.number().int().min(0).nullable(),
  /** Candidates left for the next run because of the per-run cap. */
  remaining: z.number().int().min(0).nullable(),
  /** User-safe sentence written by the workflow; never provider text. */
  user_message: z.string().nullable(),
});

/**
 * Why a run cannot start. The first five are the AI-key problems; `no_model`
 * is a resolved key that names no model (an own key saved without choosing
 * one).
 */
export const categorizeAiReasonSchema = z.enum([...AI_KEY_PROBLEMS, 'no_model']);

/**
 * Whether a run could start right now, and why not. `reason` is null exactly
 * when `available` is true.
 */
export const categorizeAiStatusSchema = z.object({
  available: z.boolean(),
  reason: categorizeAiReasonSchema.nullable(),
  provider: aiProviderSchema.nullable(),
  model: z.string().nullable(),
  source: z.enum(['own', 'shared']).nullable(),
});

export const categorizeRunStatusOutputSchema = z.object({
  active: categorizeActiveRunSchema.nullable(),
  last_finished: categorizeFinishedRunSchema.nullable(),
  ai: categorizeAiStatusSchema,
});

export const categorizeRunStartResultSchema = z.object({
  run: categorizeActiveRunSchema,
  /** False when a queued/running run already existed and was joined. */
  created: z.boolean(),
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

export const categorizeUndoResultSchema = z.object({
  restored: z.number().int().min(0),
  transaction_ids: z.array(uuidSchema),
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
