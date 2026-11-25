/**
 * Pure form rules of the add/edit transaction sheet: the starting amount,
 * the picker search (filter + "create" offer), which account the entry lands
 * on, and what Save sends. Generic over the picker rows so it needs no wire
 * types. (Spending/Income and category resolution live in sheetKind.ts.)
 */

import { payeeWrite } from './inlineAdd';
import type { Cents, Transaction } from './types';

/** An edit starts from the stored amount (whichever flow is set); a new entry from 0. */
export function initialSheetAmount(editTxn: Transaction | null): Cents {
  return editTxn ? (editTxn.inflow > 0 ? editTxn.inflow : editTxn.outflow) : 0;
}

/** Rows whose label contains the search (trimmed, case-insensitive); a blank search keeps all. */
export function searchByLabel<T>(items: readonly T[], search: string, labelOf: (item: T) => string): T[] {
  const q = search.trim().toLowerCase();
  return items.filter((item) => !q || labelOf(item).toLowerCase().includes(q));
}

/** Offer "create <search>" when something is typed and no row is named exactly that (case-insensitive). */
export function canCreateNamed(items: readonly { name: string }[], search: string): boolean {
  const q = search.trim().toLowerCase();
  return q.length > 0 && !items.some((item) => item.name.toLowerCase() === q);
}

interface AccountLike {
  id: string;
  closed: boolean;
}

/** The entry's account: the picked one (even when closed), else the first open account. */
export function sheetAccount<A extends AccountLike>(accounts: readonly A[] | undefined, accountId: string | null): A | undefined {
  return accounts?.find((a) => a.id === accountId) ?? accounts?.find((a) => !a.closed);
}

/**
 * Accounts offered by the picker. The txn's own account stays listed even
 * when closed (editing an existing row on a closed account); closed accounts
 * are otherwise not pick targets.
 */
export function pickableAccounts<A extends AccountLike>(accounts: readonly A[], accountId: string | null): A[] {
  return accounts.filter((a) => !a.closed || a.id === accountId);
}

/** Save needs a positive amount (an expression can settle at zero or below). */
export function canSaveAmount(settled: Cents): boolean {
  return settled > 0;
}

export interface SheetForm {
  accountId: string;
  date: string;
  payee: string;
  /** The picked payee's id (an existing payee, a transfer payee too); null for typed text. */
  payeeId: string | null;
  /** The resolved category (null = Ready to Assign / uncategorized). */
  categoryId: string | null;
  isIncome: boolean;
  /** The keypad's settled amount. */
  amount: Cents;
}

/**
 * The fields an edit rewrites: income is an inflow, spending an outflow. The
 * payee goes only when it changed (a picked one by id, typed text as text).
 */
export function sheetEditPatch(form: SheetForm, original: Pick<Transaction, 'payee' | 'payeeId'>) {
  return {
    accountId: form.accountId,
    date: form.date,
    ...payeeWrite({ payee: form.payee, payeeId: form.payeeId }, original),
    categoryId: form.categoryId,
    outflowCents: form.isIncome ? 0 : form.amount,
    inflowCents: form.isIncome ? form.amount : 0,
  };
}

/** A new entry: uncleared, approved, no memo / flag / repeat. */
export function sheetNewTransaction(form: SheetForm) {
  return {
    accountId: form.accountId,
    date: form.date,
    payee: form.payee.trim(),
    payeeId: form.payeeId,
    categoryId: form.categoryId,
    memo: '',
    outflowCents: form.isIncome ? 0 : form.amount,
    inflowCents: form.isIncome ? form.amount : 0,
    cleared: 'uncleared' as const,
    approved: true,
    flag: null,
    repeat: 'never',
  };
}
