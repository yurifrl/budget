/**
 * The app's "does this row still need a category?" rule. PURE.
 *
 * One rule consumed twice:
 *  - the client register uses `categoryNeed` to choose the category cell
 *    ("Needs category", "Transfer", "Split", "Ready to Assign", the category
 *    name);
 *  - the API categorizer uses `needsCategory` as the oracle its candidate SQL
 *    is tested against (api/src/categorize/candidate-rule.test.ts), so a
 *    transaction the register says needs a category is exactly one a run may
 *    suggest a category for.
 *
 * The caller supplies the facts the rule does not compute itself:
 * `transferPending` comes from the server's transfer plan (`transferOverview`
 * pending: a payee-rule row waiting for its other side, or one kept outside the
 * budget) and `transferPayee` from `isInternalTransferPayee` with the budget's
 * accounts. This keeps the rule independent of budget/plumbing shape.
 *
 * Order matters and mirrors the register cell: an auto-booked adjustment never
 * needs a category; a categorized row does not; a split parent shows Split; a
 * row the transfer plan marked pending shows Transfer; an internal
 * "Transfer : <account>" payee shows Transfer; money in goes to Ready to
 * Assign; everything else needs a category.
 */

/** Stored payee of a reconcile / working-balance edit (English, identity). */
export const SYSTEM_RECONCILIATION_PAYEE = 'Reconciliation Adjustment';
/** Stored payee of a legacy opening/balance edit (English, identity). */
export const SYSTEM_BALANCE_ADJUSTMENT_PAYEE = 'Balance Adjustment';

export function isSystemAdjustmentPayee(name: string | null | undefined): boolean {
  return name === SYSTEM_RECONCILIATION_PAYEE || name === SYSTEM_BALANCE_ADJUSTMENT_PAYEE;
}

export type CategoryNeedInput = {
  payee: string | null;
  categoryId: string | null;
  /** Number of live split legs; a split parent carries categoryId null. */
  splitCount: number;
  /**
   * Signed amount in the caller's unit (the API uses milliunits, the client
   * cents). Only the sign is read: money in does not need a category.
   */
  amount: number;
  /** The transfer plan's pending state for this row, or null. */
  transferPending: 'waiting' | 'outside' | null;
  /** The payee is the app's internal "Transfer : <on-budget account>" payee. */
  transferPayee: boolean;
};

export type CategoryNeedReason =
  | 'categorized'
  | 'reconciliation'
  | 'split'
  | 'transfer_waiting'
  | 'transfer_outside'
  | 'transfer'
  | 'inflow'
  | 'needs_category';

export function categoryNeed(input: CategoryNeedInput): CategoryNeedReason {
  if (isSystemAdjustmentPayee(input.payee)) return 'reconciliation';
  if (input.categoryId != null) return 'categorized';
  if (input.splitCount > 0) return 'split';
  if (input.transferPending === 'waiting') return 'transfer_waiting';
  if (input.transferPending === 'outside') return 'transfer_outside';
  if (input.transferPayee) return 'transfer';
  if (input.amount > 0) return 'inflow';
  return 'needs_category';
}

/** The one boolean both consumers need. */
export function needsCategory(input: CategoryNeedInput): boolean {
  return categoryNeed(input) === 'needs_category';
}
