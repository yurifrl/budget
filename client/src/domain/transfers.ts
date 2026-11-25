/**
 * Transfers on the client: a transfer is defined by its payee (an account's
 * "Transfer : <account>" payee, `transfer_account_id` set) or the row's
 * transfer pointer, never by reading the payee text or matching account
 * names. One rule for "needs no category" (shared `isTransferBetweenOnBudget`)
 * and one list of the accounts a transfer may go to. PURE.
 */

import { isTransferBetweenOnBudget } from '@shared/domain/transfers';

import type { Account, Transaction } from './types';

/** A transfer between two on-budget accounts: no category needed, none settable. */
export function isBudgetTransfer(
  accounts: readonly Pick<Account, 'id' | 'onBudget'>[],
  txn: Pick<Transaction, 'accountId' | 'transferAccountId'>,
): boolean {
  return isTransferBetweenOnBudget(accounts, txn.accountId, txn.transferAccountId);
}

/** The same rule for a draft: the row's account and the picked transfer payee's account. */
export function isBudgetTransferTo(
  accounts: readonly Pick<Account, 'id' | 'onBudget'>[],
  accountId: string,
  transferAccountId: string | null | undefined,
): boolean {
  return isTransferBetweenOnBudget(accounts, accountId, transferAccountId);
}

/**
 * The accounts a transfer may go to, everywhere (payee picker, the "Looks
 * like a transfer" popover): the budget's open accounts except the row's own.
 * Off-budget accounts are offered (the UI labels them); closed ones are not.
 */
export function transferTargets<A extends Pick<Account, 'id' | 'group'>>(accounts: readonly A[], exceptId?: string | null): A[] {
  return accounts.filter((a) => a.group !== 'CLOSED' && a.id !== exceptId);
}

/** What the transfer list reads of a payee row (the wire row satisfies it). */
interface TransferPayee {
  id: string;
  transfer_account_id: string | null;
  deleted: boolean;
}

/** The transfer payees of the accounts `transferTargets` allows ("Payments and Transfers"), in account order. */
export function transferChoices<P extends TransferPayee, A extends Pick<Account, 'id' | 'group'>>(
  payees: readonly P[],
  accounts: readonly A[],
  exceptAccountId?: string | null,
): { payee: P; account: A }[] {
  const byAccount = new Map(payees.filter((p) => p.transfer_account_id && !p.deleted).map((p) => [p.transfer_account_id as string, p]));
  const out: { payee: P; account: A }[] = [];
  for (const account of transferTargets(accounts, exceptAccountId)) {
    const payee = byAccount.get(account.id);
    if (payee) out.push({ payee, account });
  }
  return out;
}

/** The account a payee id stands for when it is a transfer payee, else null. */
export function transferAccountOfPayee(
  payees: readonly { id: string; transfer_account_id: string | null }[],
  payeeId: string | null | undefined,
): string | null {
  if (!payeeId) return null;
  return payees.find((p) => p.id === payeeId)?.transfer_account_id ?? null;
}

/**
 * A patch as it applies to one row: a transfer between on-budget accounts
 * takes no category, so `categoryId` is dropped from its patch (the rest of
 * the patch, such as approving it, still applies). Null when nothing is left.
 */
export function patchForRow<P extends object>(
  accounts: readonly Pick<Account, 'id' | 'onBudget'>[],
  txn: Pick<Transaction, 'accountId' | 'transferAccountId'>,
  patch: P,
): P | null {
  if (!('categoryId' in patch) || !isBudgetTransfer(accounts, txn)) return patch;
  const { categoryId: _dropped, ...rest } = patch as { categoryId?: unknown };
  return Object.keys(rest).length > 0 ? (rest as unknown as P) : null;
}
