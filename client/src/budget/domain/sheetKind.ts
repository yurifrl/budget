/**
 * Pure income/category resolution for the add/edit transaction sheet.
 * "Income" is the amount direction (inflow); the category is separate — an
 * inflow with a category (e.g. a refund in Groceries) keeps it, and only an
 * uncategorized inflow is Ready to Assign.
 */

import type { Transaction } from './types';

export interface SheetKind {
  isIncome: boolean;
  categoryId: string | null;
}

/** Initial sheet state: an edit mirrors the stored txn; a new one is spending. */
export function initialSheetKind(editTxn: Transaction | null, prefillCategoryId: string | null): SheetKind {
  if (!editTxn) return { isIncome: false, categoryId: prefillCategoryId };
  return { isIncome: editTxn.inflow > 0, categoryId: editTxn.categoryId };
}

/** User flips Spending/Income: becoming income means Ready to Assign. */
export function toggleSheetKind(s: SheetKind): SheetKind {
  const isIncome = !s.isIncome;
  return { isIncome, categoryId: isIncome ? null : s.categoryId };
}

/**
 * Category id that is displayed and saved. New income is always Ready to
 * Assign; an edited inflow keeps whatever category it has (null = Ready to
 * Assign), so editing e.g. the payee never moves money out of its category.
 */
export function resolveSheetCategory(s: SheetKind, editing: boolean): string | null {
  return s.isIncome && !editing ? null : s.categoryId;
}
