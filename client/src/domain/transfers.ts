/**
 * Transfers on the client: a transfer is defined by its payee (an account's
 * "Transfer : <account>" payee, `transfer_account_id` set) or the row's
 * transfer pointer, never by reading the payee text or matching account
 * names (the one exception is `legacyTransferAccountByName`). One rule for "needs no category" (shared `isTransferToOnBudget`)
 * and one list of the accounts a transfer may go to. PURE.
 */

import { isTransferToOnBudget, transferPeerAccountId } from '@shared/domain/transfers';

import type { Account, Transaction } from './types';

/** A transfer to an on-budget account (the money stays in the budget): no category needed, none settable. */
export function isBudgetTransfer(
  accounts: readonly Pick<Account, 'id' | 'onBudget'>[],
  txn: Pick<Transaction, 'accountId' | 'transferAccountId'>,
): boolean {
  return isTransferToOnBudget(accounts, txn.accountId, txn.transferAccountId);
}

/**
 * What the engine treats as a transfer (zeroSum): the row's own account AND its
 * peer are on budget, so the money never leaves the budget. Reflect uses this
 * to leave such rows out of spending. `isBudgetTransfer` (peer only, as the
 * register always read it) is for the category cell and the lock.
 */
export function isEngineTransfer(
  accounts: readonly Pick<Account, 'id' | 'onBudget'>[],
  txn: Pick<Transaction, 'accountId' | 'transferAccountId'>,
): boolean {
  return !!accounts.find((a) => a.id === txn.accountId)?.onBudget && isBudgetTransfer(accounts, txn);
}

/** The same rule for a draft: the row's account and the picked transfer payee's account. */
export function isBudgetTransferTo(
  accounts: readonly Pick<Account, 'id' | 'onBudget'>[],
  accountId: string,
  transferAccountId: string | null | undefined,
): boolean {
  return isTransferToOnBudget(accounts, accountId, transferAccountId);
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

/**
 * LEGACY FALLBACK, kept only until the server repair has linked the old
 * name-only duplicate payees (`repair-transfer-payees`): a row that has no
 * pointer and whose payee is not a linked transfer payee, but whose payee name
 * is "Transfer : <name>" of exactly one account of the budget, is a transfer
 * to that account, as the client has always treated it (so Ready to Assign and
 * the balances do not move when this client replaces the old one). Case and
 * spacing around the colon are ignored, as before. Two accounts of that name
 * (ambiguous), no account of that name (a renamed account's old payee text) or
 * the row's own account: not a transfer. Closed accounts count, as before.
 * Called by the mapping layer only; delete it with the repair.
 */
export function legacyTransferAccountByName(
  payeeName: string,
  accounts: readonly { id: string; name: string }[],
  ownAccountId: string,
): string | null {
  return transferPeerAccountId(payeeName, accounts, ownAccountId) ?? null;
}

/**
 * The account a row being edited or entered transfers to, for locking its
 * category. A row whose payee was not touched keeps the transfer state it has
 * (so a legacy row with no payee id is locked like any other); a payee picked
 * now is a transfer when it is an account's transfer payee.
 */
export function draftTransferAccount(
  original: Pick<Transaction, 'payee' | 'payeeId' | 'transferAccountId'> | null | undefined,
  draft: { payee: string; payeeId: string | null },
  payees: readonly { id: string; transfer_account_id: string | null }[],
): string | null {
  const untouched = !!original && draft.payeeId === (original.payeeId ?? null) && draft.payee === original.payee;
  return untouched ? (original.transferAccountId ?? null) : transferAccountOfPayee(payees, draft.payeeId);
}
