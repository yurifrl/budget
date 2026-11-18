/**
 * App-facing types of the budgetApi endpoints that are not plain row types
 * (those live in ../rows.ts). Wire shapes derive from the shared contracts'
 * output schemas; the payload types are what the app passes in (cents).
 */
import type { z } from '@shared/zod';
import type {
  budgetMembersSchema,
  budgetRestore,
  categoryNoteRowSchema,
  categoryTargetRowSchema,
  payeeSuggestionSchema,
  payeeTxnRowSchema,
  transactionsCreate,
} from '@shared/contracts/budget';

import type { Person } from '../../domain/people';
import type { CategoryTarget, Cents } from '../../domain/types';
import { milliToCents } from '../mapping';

/** snakeSubTxn rows as the contract's `subtransactions` input; restore payload as its input minus budget_id. */
export type SubWire = z.input<typeof transactionsCreate.input>['subtransactions'];
export type RestoreWire = Omit<z.input<typeof budgetRestore.input>, 'budget_id'>;

/**
 * Engine-facing target payload for PUT /category-targets — mirrors
 * `CategoryTarget` in domain/types.ts (cents + camelCase config JSONB).
 */
export interface CategoryTargetPayload {
  kind: 'weekly' | 'monthly' | 'yearly' | 'custom';
  amountCents: Cents;
  /** MonthKey (YYYYMM) whose need the target skips (syscd-app-hsjm). */
  snoozeMonth?: number | null;
  config: Record<string, unknown>;
}

/** Row returned by GET /category-targets (wire shape, amount in milliunits). */
export type CategoryTargetRow = z.infer<typeof categoryTargetRowSchema>;

/** Rows keyed by category (single definition — plan grid, move-money flow, auto-assign). */
export function targetsByCategoryFromRows(rows: readonly CategoryTargetRow[]): Map<string, CategoryTarget> {
  const map = new Map<string, CategoryTarget>();
  for (const row of rows) {
    map.set(row.category_id, {
      categoryId: row.category_id,
      kind: row.kind,
      amountCents: milliToCents(row.amount),
      snoozeMonth: row.snooze_month,
      config: row.config,
    });
  }
  return map;
}

/** One category's note for one month (category_notes table, syscd-app-nrg). */
export type CategoryNoteRow = z.infer<typeof categoryNoteRowSchema>;

/** GET /payee-suggestions/:id — what the payee's next transaction would be
 * categorized as (server infers per categorization mode + history). */
export type PayeeSuggestionRow = z.infer<typeof payeeSuggestionSchema>;

/** One row of GET /payees/:id/transactions (date DESC, signed milliunits). */
export type PayeeTxnRow = z.infer<typeof payeeTxnRowSchema>;

/** A person a budget is shared with (GET /budget-members). */
export type BudgetMember = Person;
export type BudgetMembersResponse = z.infer<typeof budgetMembersSchema>;
