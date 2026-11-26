/**
 * Which categories a transaction may be put in. The app's own categories
 * (flagged `internal`) and the "Credit Card Payments" group's categories are
 * never picked for a transaction: card payments are made with a transfer to
 * the card's transfer payee, and the engine fills those envelopes. PURE.
 */

import type { Category, CategoryGroup } from './types';

type GroupFlags = Pick<CategoryGroup, 'id' | 'isCreditCardPayments' | 'internal'>;

/** True when a transaction may carry this category. */
export function isPickableCategory(category: Pick<Category, 'groupId' | 'internal'>, groups: readonly GroupFlags[]): boolean {
  if (category.internal) return false;
  const group = groups.find((g) => g.id === category.groupId);
  return !group?.internal && !group?.isCreditCardPayments;
}

/** The categories any category picker lists (order kept). */
export function pickableCategories<C extends Pick<Category, 'groupId' | 'internal'>>(categories: readonly C[], groups: readonly GroupFlags[]): C[] {
  return categories.filter((c) => isPickableCategory(c, groups));
}
