/**
 * The per-account transfer payee ("Transfer : <account>"): one system payee
 * per account, identified by id, never by name.
 *
 *  - `payees.transfer_account_id` and `accounts.transfer_payee_id` always
 *    agree: every function here sets both together.
 *  - Created with the account (`ensureTransferPayee`, called by every
 *    account-creation path), renamed with it (`renameTransferPayee`, same
 *    database transaction as the account rename), kept when the account is
 *    closed, retired only when the account is deleted.
 *  - Payee names are unique per budget, so a second account with the same name
 *    gets "Transfer : <name> (2)", the third "(3)". The id, not the name, is
 *    the identity.
 *  - Uniqueness ("exactly one per account") is enforced here, in code, not by
 *    an index: the database is shared with another running app whose writes a
 *    unique index could break. `repairTransferPayees` (transfer-payee-repair.ts)
 *    heals what that app or old versions left behind.
 *
 * Callers pass a Queryable that already runs inside the caller's transaction.
 */
import type { Queryable } from '../../core/db';
import { HttpError } from '../../core/validate';
import { TRANSFER_PAYEE_RE, transferPayeeName } from '@shared/domain/transfers';
import * as store from '../store/transfer-payees';
import type { PayeeFullRow } from '../store/transfer-payees';

const MAX_NAME_ATTEMPTS = 200;

/** "Transfer : X", or "Transfer : X (n)" from the second claimant of a name on. */
export function transferPayeeCandidate(accountName: string, n: number): string {
  const base = transferPayeeName(accountName);
  return n <= 1 ? base : `${base} (${n})`;
}

/** True for the base name and for its numbered variants ("Transfer : X (2)"). */
export function isTransferPayeeNameFor(payeeName: string, accountName: string): boolean {
  const base = transferPayeeName(accountName);
  return payeeName === base || (payeeName.startsWith(`${base} (`) && /^ \(\d+\)$/.test(payeeName.slice(base.length)));
}

/**
 * The canonical payee among those pointing at one account (oldest first):
 * the account's own pointer when it is live and among them, else the oldest
 * live one, else (all retired) the pointed one or the oldest.
 */
export function pickCanonical<T extends { id: string; deleted: boolean }>(
  pointerId: string | null,
  linked: readonly T[],
): T | undefined {
  const live = linked.filter((p) => !p.deleted);
  return live.find((p) => p.id === pointerId) ?? live[0] ?? linked.find((p) => p.id === pointerId) ?? linked[0];
}

/** The error every payee endpoint throws for a payee the system owns. */
export function transferPayeeProtected(name: string): HttpError {
  return new HttpError(
    409,
    `"${name}" is the transfer payee of an account. It follows the account's name and cannot be renamed, merged, hidden or deleted.`,
    'transfer_payee_protected',
    { name },
  );
}

/** Throw `transfer_payee_protected` when the payee is an account's transfer payee. */
export async function assertNotTransferPayee(db: Queryable, budgetId: string, payeeId: string): Promise<void> {
  const row = await store.getPayeeRow(db, budgetId, payeeId);
  if (row?.transfer_account_id) throw transferPayeeProtected(row.name);
}

type NameChoice =
  | { kind: 'free'; name: string }
  | { kind: 'self'; name: string }
  | { kind: 'take'; name: string; holder: PayeeFullRow };

/**
 * The first name in "Transfer : X", "Transfer : X (2)", ... that this account's
 * payee can use: free, already its own, or held by a payee it may take over
 * (a duplicate pointing at the same account, or a name-only payee when the
 * account name is unambiguous). A name held by another account's payee is skipped.
 */
async function chooseName(
  db: Queryable,
  account: store.AccountPayeeRow,
  selfId: string | null,
  accountNameIsUnique: boolean,
): Promise<NameChoice> {
  const liveIds = new Set((await store.listLiveAccounts(db, account.budget_id)).map((a) => a.id));
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
    const name = transferPayeeCandidate(account.name, n);
    const holder = await store.findPayeeRowByName(db, account.budget_id, name);
    if (!holder) return { kind: 'free', name };
    if (holder.id === selfId) return { kind: 'self', name };
    if (holder.transfer_account_id === account.id) return { kind: 'take', name, holder };
    const heldElsewhere = holder.transfer_account_id !== null && liveIds.has(holder.transfer_account_id);
    // A payee nobody links to with exactly the base name is a name-only
    // transfer payee of this account when no other account shares the name.
    if (!heldElsewhere && n === 1 && accountNameIsUnique) return { kind: 'take', name, holder };
  }
  throw new HttpError(409, 'no free transfer payee name for this account', 'conflict');
}

async function accountNameIsUnique(db: Queryable, account: store.AccountPayeeRow): Promise<boolean> {
  return (await store.liveAccountIdsByName(db, account.budget_id, account.name)).length <= 1;
}

/**
 * The account's canonical transfer payee id, created (or adopted from a
 * name-only payee) when missing. Self-healing: a pointer that does not agree
 * with the payee, a retired or hidden payee, or duplicates, resolve to one live
 * canonical payee and both columns agree afterwards. Duplicates are NOT merged
 * here (that is the repair).
 */
export async function ensureTransferPayee(
  db: Queryable,
  budgetId: string,
  accountId: string,
  /** Unused: the account's name is read from the database. Kept so call sites stay unchanged. */
  _accountName?: string,
): Promise<string> {
  const account = await store.getAccountRow(db, accountId);
  if (!account || account.budget_id !== budgetId || account.deleted) {
    throw new HttpError(400, 'account not found in budget', 'account_not_in_budget');
  }
  const linked = await store.listPayeesLinkedTo(db, budgetId, accountId);
  const canonical = pickCanonical(account.transfer_payee_id, linked);
  if (canonical) {
    if (canonical.deleted || canonical.hidden) await store.linkPayeeToAccount(db, canonical.id, accountId);
    if (account.transfer_payee_id !== canonical.id) await store.setAccountTransferPayee(db, accountId, canonical.id);
    return canonical.id;
  }
  const unique = await accountNameIsUnique(db, account);
  for (let attempt = 0; attempt < 5; attempt++) {
    const choice = await chooseName(db, account, null, unique);
    let payeeId: string | null;
    if (choice.kind === 'take') {
      await store.linkPayeeToAccount(db, choice.holder.id, accountId);
      payeeId = choice.holder.id;
    } else {
      // 'self' cannot happen without a canonical payee; a lost race re-reads.
      payeeId = await store.insertTransferPayee(db, budgetId, choice.name, accountId);
    }
    if (payeeId) {
      await store.setAccountTransferPayee(db, accountId, payeeId);
      return payeeId;
    }
  }
  throw new HttpError(409, 'could not create the transfer payee', 'conflict');
}

export interface AbsorbResult {
  transactions: number;
  ruleMoved: boolean;
  ruleDropped: boolean;
}

/**
 * Fold a duplicate payee into the canonical one: every reference (transactions,
 * splits, scheduled rows, repeat rules, link records, account pointers) moves,
 * the renaming rule and the "treat as transfer" rule move when the canonical
 * payee has none, then the duplicate row is deleted. A renaming rule is
 * dropped (and reported) only when the canonical payee already has a
 * different one: a payee holds a single rule.
 */
export async function absorbPayee(db: Queryable, budgetId: string, fromId: string, intoId: string): Promise<AbsorbResult> {
  const from = await store.getPayeeRow(db, budgetId, fromId);
  const into = await store.getPayeeRow(db, budgetId, intoId);
  if (!from || !into || from.id === into.id) return { transactions: 0, ruleMoved: false, ruleDropped: false };
  const transactions = await store.repointPayeeReferences(db, from.id, into.id);
  let ruleMoved = false;
  let ruleDropped = false;
  if (from.rename_condition !== null && from.rename_match_type !== null) {
    await store.clearRenameRule(db, from.id);
    if (into.rename_condition === null) {
      await store.setRenameRule(db, into.id, from.rename_match_type, from.rename_condition);
      ruleMoved = true;
    } else if (into.rename_condition !== from.rename_condition) {
      ruleDropped = true;
    }
  }
  if (from.transfer_rule !== null && into.transfer_rule === null) await store.copyTransferRule(db, from.id, into.id);
  await store.deletePayeeRow(db, from.id);
  return { transactions, ruleMoved, ruleDropped };
}

/**
 * Bring the account's transfer payee in line with the account's CURRENT name
 * (call after the account row was renamed, in the same transaction). Same
 * payee id, new name; a stale duplicate or name-only payee already holding the
 * new name is folded into it first; a name held by another account's payee
 * gets the "(2)" variant.
 */
export async function renameTransferPayee(db: Queryable, budgetId: string, accountId: string): Promise<void> {
  const canonicalId = await ensureTransferPayee(db, budgetId, accountId);
  const account = (await store.getAccountRow(db, accountId))!;
  const unique = await accountNameIsUnique(db, account);
  const choice = await chooseName(db, account, canonicalId, unique);
  if (choice.kind === 'self') return;
  if (choice.kind === 'take') await absorbPayee(db, budgetId, choice.holder.id, canonicalId);
  await store.setPayeeName(db, canonicalId, choice.name);
}

/**
 * The payee id a payee TEXT means, for the register's create/edit paths, or
 * null when the text is an ordinary payee name (the caller then upserts it).
 *
 *  1. The text is exactly the name of an account's transfer payee: that
 *     account's canonical payee (names are unique per budget, so this is one
 *     payee, whatever the accounts are called now).
 *  2. The text reads "Transfer : <name>" without being a payee's name (an
 *     older client, a renamed account, a hand-typed name): the canonical
 *     payee of the one live account called <name>; none = ordinary payee;
 *     several = refused, never guessed.
 */
export async function resolveTransferPayeeText(db: Queryable, budgetId: string, text: string): Promise<string | null> {
  const exact = await store.findPayeeRowByName(db, budgetId, text);
  if (exact?.transfer_account_id && !exact.deleted) {
    const account = await store.getAccountRow(db, exact.transfer_account_id);
    // A link to an account that is gone or in another budget is left to the
    // peer check (400 transfer_account_not_in_budget), as before.
    if (!account || account.budget_id !== budgetId || account.deleted) return exact.id;
    return ensureTransferPayee(db, budgetId, account.id);
  }
  const peerName = TRANSFER_PAYEE_RE.exec(text)?.[1]?.trim();
  if (!peerName) return null;
  const accountIds = await store.liveAccountIdsByName(db, budgetId, peerName);
  if (accountIds.length === 0) return null;
  if (accountIds.length > 1) {
    throw new HttpError(
      409,
      `More than one account is named "${peerName}", so "${text}" could mean any of them. Pick the transfer from the account list.`,
      'transfer_payee_ambiguous',
      { name: peerName },
    );
  }
  return ensureTransferPayee(db, budgetId, accountIds[0]!);
}
