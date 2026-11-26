/**
 * Transfer payee syntax — the canonical naming for account-transfer payees.
 *
 * A transfer between two budget accounts is recorded as a pair of mirrored
 * transactions whose payee names the OTHER account: "Transfer : <name>". The
 * zero-sum engine reads `Transaction.transferAccountId`; the mapping layer fills it
 * from this convention (`transferPeerAccountId`) for rows the server never
 * linked, and the import/export pipeline uses it for pairing and validation.
 *
 * SHARED CONTRACT — consumed by data/mapping, transfer/payload and
 * transfer/transfer.
 */

/** Exact prefix a transfer payee starts with. */
export const TRANSFER_PAYEE_PREFIX = 'Transfer : ';

/** Matches a transfer payee; capture group 1 is the peer account name. */
export const TRANSFER_PAYEE_RE = /^Transfer\s*:\s*(.+)$/;

/** Transfer payee naming: "Transfer : <account name>". */
export function transferPayeeName(accountName: string): string {
  return `${TRANSFER_PAYEE_PREFIX}${accountName}`;
}

/**
 * True when `payee` names an ON-budget account in `accounts`: the money stays
 * inside the budget, so the row needs no category (the engine skips it too).
 */
export function isInternalTransferPayee(
  payee: string,
  accounts: readonly { name: string; onBudget: boolean }[],
): boolean {
  // Trimmed like `transferPeerAccountId` below: both helpers answer for the
  // same payee text, so "Transfer : Savings " must mean Savings in both.
  const peer = TRANSFER_PAYEE_RE.exec(payee)?.[1]?.trim().toLowerCase();
  return peer !== undefined && accounts.some((a) => a.onBudget && a.name.toLowerCase() === peer);
}

/**
 * The account id a legacy "Transfer : <account name>" payee points at (any
 * account, on or off budget; case-insensitive), or undefined when the payee is
 * not a transfer, names no account, names an ambiguous one, or names
 * `ownAccountId` itself. Used to fill `Transaction.transferAccountId` for rows
 * the server never linked (spec T1).
 */
export function transferPeerAccountId(
  payee: string,
  accounts: readonly { id: string; name: string }[],
  ownAccountId: string,
): string | undefined {
  const peer = TRANSFER_PAYEE_RE.exec(payee)?.[1]?.trim().toLowerCase();
  if (peer === undefined) return undefined;
  const matches = accounts.filter((a) => a.name.toLowerCase() === peer);
  return matches.length === 1 && matches[0]!.id !== ownAccountId ? matches[0]!.id : undefined;
}

/**
 * THE definition of a transfer that needs no category: the row points at
 * another account (`peerAccountId`: the server's transfer pointer, which a
 * transfer payee sets) and that account is on budget, so the money stays inside
 * the budget. A transfer to an off-budget account leaves the budget and keeps
 * its category. Same outcome as the register always had (it looked at the peer
 * only). Never read from the payee text.
 */
export function isTransferToOnBudget(
  accounts: readonly { id: string; onBudget: boolean }[],
  accountId: string,
  peerAccountId: string | null | undefined,
): boolean {
  if (!peerAccountId || peerAccountId === accountId) return false;
  return !!accounts.find((a) => a.id === peerAccountId)?.onBudget;
}
