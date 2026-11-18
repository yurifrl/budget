/**
 * Pure rules behind the account register (AccountsScreen, the linked-account
 * register): category cell text, row filtering and search.
 */

import { isInternalTransferPayee } from '@shared/domain/transfers';

import type { Budget, Transaction } from './types';

/**
 * Category cell text for a register row. YNAB shows every auto-booked
 * adjustment (reconcile or working-balance edit, including close zeroing)
 * categorized to Inflow: Ready to Assign. On-budget <-> on-budget transfers
 * carry no category by design and read "Transfer" (`transfers: false` skips
 * that check, as the linked-account register always did).
 */
export function registerCategoryCell(
  budget: Pick<Budget, 'accounts' | 'categories'>,
  t: Pick<Transaction, 'payee' | 'categoryId' | 'splits' | 'inflow'>,
  { transfers = true }: { transfers?: boolean } = {},
): { text: string; warn: boolean } {
  if (t.payee === 'Reconciliation Adjustment' || t.payee === 'Balance Adjustment') {
    return { text: 'Ready to Assign', warn: false };
  }
  if (!t.categoryId) {
    if (t.splits?.length) return { text: `Split (${t.splits.length})`, warn: false };
    if (transfers && isInternalTransferPayee(t.payee, budget.accounts)) return { text: 'Transfer', warn: false };
    return t.inflow > 0 ? { text: 'Ready to Assign', warn: false } : { text: 'needs category', warn: true };
  }
  const cat = budget.categories.find((c) => c.id === t.categoryId);
  return { text: cat?.name ?? '?', warn: false };
}
