/**
 * Zod schemas shared by the budget operation contracts (and their handlers).
 * Pure: imports zod, the shared validators in core/validate and the pure
 * payee domain only — safe for contracts the app bundle will import.
 */
import { z } from '../../zod';

import { categorizationModes, matchTypes } from '../../domain/payees';
import {
  centsSchema,
  clearedSchema,
  flagSchema,
  isoDateSchema,
  monthDateSchema,
  uuidSchema,
} from '../../validation';
import { FREQUENCIES } from './frequencies';

export { uuidSchema, monthDateSchema, centsSchema, isoDateSchema };

/** Every budget-scoped endpoint addresses its budget with this key. */
export const budgetId = uuidSchema;
/** Trimmed 1..120 chars — group/category/payee/budget names. */
export const nameSchema = z.string().trim().min(1).max(120);
/** Freeform note (month/category notes). */
export const noteSchema = z.string().max(10_000);

// ---- transactions ----------------------------------------------------------

export const ONE_WAY_ERROR = 'inflow_cents and outflow_cents cannot both be positive';

/** A transaction moves money one way — inflow XOR outflow. */
export const bothPositive = (t: { inflow_cents: number; outflow_cents: number }) =>
  t.inflow_cents > 0 && t.outflow_cents > 0;

/** One split leg (subtransactions row, syscd-app-rlt). Cents, inflow XOR outflow. */
export const subTxnSchema = z.object({
  category_id: uuidSchema.nullable(),
  memo: z.string().max(500).nullable(),
  outflow_cents: centsSchema,
  inflow_cents: centsSchema,
});
// Empty list is legal: PATCHing `subtransactions: []` un-splits the row.
export const subTxnListSchema = z.array(subTxnSchema).max(100);

export const txnSchema = z.object({
  account_id: uuidSchema,
  date: isoDateSchema,
  payee: z.string(),
  category_id: uuidSchema.nullable(),
  memo: z.string().nullable(),
  outflow_cents: centsSchema,
  inflow_cents: centsSchema,
  cleared: clearedSchema,
  approved: z.boolean(),
  flag: flagSchema,
  repeat: z.string(),
  matched_transaction_id: uuidSchema.nullable().optional(),
});

/** POST body: a transaction moves money one way — inflow XOR outflow. */
export const createTxnSchema = txnSchema.refine((t) => !bothPositive(t), {
  message: ONE_WAY_ERROR,
  path: ['inflow_cents'],
});

/** PATCH body: any subset of the transaction fields. */
export const patchTxnSchema = txnSchema.partial();

/** POST /bulk row — one statement-import line for a single account. */
export const bulkTxnSchema = txnSchema
  .pick({ date: true, payee: true, category_id: true, memo: true, outflow_cents: true, inflow_cents: true })
  .extend({
    /** Deterministic dedupe key (YNAB-style); null rows get one generated. */
    import_id: z.string().min(1).max(200).nullable().optional(),
    import_payee_name: z.string().max(200).optional(),
    import_payee_name_original: z.string().max(200).optional(),
  })
  .refine((t) => !bothPositive(t), { message: ONE_WAY_ERROR, path: ['inflow_cents'] });

// ---- accounts --------------------------------------------------------------

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'cash',
  'creditCard',
  'lineOfCredit',
  'otherAsset',
  'otherLiability',
  'mortgage',
  'autoLoan',
  'studentLoan',
  'personalLoan',
  'medicalDebt',
  'otherDebt',
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Optional person (budget member) the account belongs to; null = Shared. */
export const personSchema = uuidSchema.nullable().optional();

/** Bank link: an existing connection row + one of its upstream accounts. */
export const accountLinkSchema = z.object({
  connectionId: uuidSchema.nullable(),
  externalAccountId: z.string().min(1).nullable().optional(),
  institution: z.string().max(200).nullable().optional(),
});

// ---- categories ------------------------------------------------------------

export const categoryTargetInputSchema = z
  .object({
    amount_cents: centsSchema.optional(),
    cadence: z.enum(['weekly', 'monthly', 'yearly', 'custom']).optional(),
    by_date: isoDateSchema.optional(),
    behavior: z.enum(['set-aside', 'refill']).optional(),
  })
  .nullable();

export const categoryMoveSchema = z.object({
  id: uuidSchema,
  group_id: uuidSchema,
  sort_order: z.number().int(),
});

// ---- category targets (category_targets table) -------------------------------

const repeatEvery = z.number().int().min(1).max(52).optional();
const dayOfWeek = z.number().int().min(0).max(6).optional();
const fromMonth = z.number().int().min(190001).max(299912).optional();
const monthOfYear = z.number().int().min(1).max(12).optional();
const dayOfMonth = z.number().int().min(1).max(31).optional();
const byDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

/**
 * Per-kind config whitelists. Foreign keys are stripped (zod default) so the
 * API cannot be handed cross-kind config — e.g. a weekly target's
 * repeatEvery leaking into a monthly target, where the engine's monthly
 * branch would read it as a repeat count and compute 0.
 */
export const targetConfigSchemas = {
  weekly: z.object({ dayOfWeek, repeatEvery }),
  monthly: z.object({ fromMonth, repeatEvery }),
  yearly: z.object({ monthOfYear, dayOfMonth }),
  custom: z.object({ byDate }),
} as const;

export const targetKindSchema = z.enum(['weekly', 'monthly', 'yearly', 'custom']);
/** MonthKey (YYYYMM) whose need the target skips — "snooze this month". */
export const snoozeMonthSchema = z.number().int().min(190001).max(299912).nullable().optional();

// ---- assignments / plan ------------------------------------------------------

/** Stored milliunits (cents x 10) — assignments' `budgeted` is written as-is. */
export const milliunitsSchema = centsSchema.describe('Milliunits (cents x 10), e.g. 12.34 = 12340');

export const assignmentUpdateSchema = z.object({ category_id: uuidSchema, budgeted: milliunitsSchema });

export const autoAssignRowSchema = z.object({
  category_id: uuidSchema,
  // App-facing cents; auto-assign suggestions never negative.
  assign_cents: centsSchema.min(0),
});

// ---- payees ------------------------------------------------------------------

export { categorizationModes, matchTypes };
export const categorizationModeSchema = z.enum(categorizationModes);
export const matchTypeSchema = z.enum(matchTypes);

// ---- repeat rules -------------------------------------------------------------

export const frequencySchema = z.enum(FREQUENCIES);

// ---- budget restore -------------------------------------------------------------

export const restorePayloadShape = {
  groups: z.array(z.string().min(1).max(500)).max(1000),
  categories: z
    .array(
      z.object({
        groupIndex: z.number().int().min(0).max(999),
        name: z.string().min(1).max(500),
        hidden: z.boolean().optional(),
        userId: uuidSchema.nullable().optional(),
        bundleIndex: z.number().int().min(0).max(9999).nullable().optional(),
      }),
    )
    .max(10000),
  bundles: z
    .array(z.object({ groupIndex: z.number().int().min(0).max(999), name: z.string().min(1).max(500) }))
    .max(10000)
    .optional(),
  accounts: z
    .array(z.object({ name: z.string().min(1).max(500), userId: uuidSchema.nullable().optional() }))
    .max(1000),
  transactions: z
    .array(
      z.object({
        accountIndex: z.number().int().min(0).max(9999),
        date: isoDateSchema,
        payee: z.string().max(500),
        categoryIndex: z.number().int().min(0).max(9999).nullable(),
        memo: z.string().max(2000),
        outflow: centsSchema.min(0),
        inflow: centsSchema.min(0),
        cleared: clearedSchema,
        flag: z.string().max(100),
        transferPeerIndex: z.number().int().min(0).max(9999).nullable(),
      }),
    )
    .max(200000),
  assignments: z
    .array(
      z.object({
        categoryIndex: z.number().int().min(0).max(9999),
        month: monthDateSchema,
        budgeted: centsSchema,
      }),
    )
    .max(500000),
};
