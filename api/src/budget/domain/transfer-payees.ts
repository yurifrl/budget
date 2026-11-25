/**
 * The per-account transfer payee ("Transfer : <account>"): one system payee
 * per account, identified by id, never by name.
 *
 *  - `payees.transfer_account_id` and `accounts.transfer_payee_id` agree: they
 *    are set together when the payee is created.
 *  - Created with the account (`ensureTransferPayee`, called by every
 *    account-creation path), renamed with it (`renameTransferPayee`, same
 *    database transaction as the account rename), kept when the account is
 *    closed, retired only when the account is deleted.
 *  - Payee names are unique per budget, so a second account with the same name
 *    gets "Transfer : <name> (2)", the third "(3)". The id is the identity.
 *  - Uniqueness ("exactly one per account") is kept by code, not by an index:
 *    the database is shared with another running app whose writes a unique
 *    index could break.
 *
 * What ordinary requests may write (see `ensureTransferPayee`): INSERT a
 * missing payee for an account, adopt a live unlinked payee that already has
 * exactly the account's name, and set the account's pointer when it is empty.
 * They never merge, delete, un-hide, un-delete or re-point anything: bad data
 * is used as it is and left to the repair (transfer-payee-repair.ts), the only
 * place that merges and deletes.
 *
 * Callers pass a Queryable that already runs inside the caller's transaction.
 */
import type { Queryable } from '../../core/db';
import { HttpError } from '../../core/validate';
import { TRANSFER_PAYEE_RE, transferPayeeName } from '@shared/domain/transfers';
import * as store from '../store/transfer-payees';
import type { AccountPayeeRow, PayeeFullRow } from '../store/transfer-payees';

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
  | { kind: 'mine'; name: string; holder: PayeeFullRow }
  | { kind: 'adopt'; name: string; holder: PayeeFullRow };

/**
 * The first name in "Transfer : X", "Transfer : X (2)", ... a NEW payee of this
 * account can use: free; held by a payee that already points at the account
 * (use it); or the plain name held by a live payee nobody links to, when no
 * other account shares the name (a name-only transfer payee: adopt it).
 * Everything else is skipped, never touched.
 */
async function chooseNewName(db: Queryable, account: AccountPayeeRow, accountNameIsUnique: boolean): Promise<NameChoice> {
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
    const name = transferPayeeCandidate(account.name, n);
    const holder = await store.findPayeeRowByName(db, account.budget_id, name);
    if (!holder) return { kind: 'free', name };
    if (holder.transfer_account_id === account.id) return { kind: 'mine', name, holder };
    if (n === 1 && accountNameIsUnique && holder.transfer_account_id === null && !holder.deleted) return { kind: 'adopt', name, holder };
  }
  throw new HttpError(409, 'no free transfer payee name for this account', 'conflict');
}

async function accountNameIsUnique(db: Queryable, account: AccountPayeeRow): Promise<boolean> {
  return (await store.liveAccountIdsByName(db, account.budget_id, account.name)).length <= 1;
}

/**
 * Create the account's transfer payee and point the account at it (replacing
 * any pointer: callers decide whether that is allowed). Used by
 * `ensureTransferPayee` (pointer empty) and by the repair.
 */
export async function createTransferPayee(db: Queryable, account: AccountPayeeRow): Promise<string> {
  const unique = await accountNameIsUnique(db, account);
  for (let attempt = 0; attempt < 5; attempt++) {
    const choice = await chooseNewName(db, account, unique);
    let payeeId: string | null = null;
    if (choice.kind === 'mine') payeeId = choice.holder.id;
    else if (choice.kind === 'adopt') payeeId = (await store.adoptPayee(db, choice.holder.id, account.id)) ? choice.holder.id : null;
    else payeeId = await store.insertTransferPayee(db, account.budget_id, choice.name, account.id);
    if (payeeId) {
      await store.setAccountTransferPayee(db, account.id, payeeId);
      return payeeId;
    }
  }
  throw new HttpError(409, 'could not create the transfer payee', 'conflict');
}

/**
 * The account's transfer payee id. Uses what exists without writing: the
 * account's pointer, else the canonical payee that points at the account.
 * Only when there is neither does it CREATE one (and set the account's
 * pointer). It never un-hides, un-deletes, re-points or merges: inconsistent
 * data is the repair's job (a hidden, retired or duplicated payee is used as
 * is).
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
  if (account.transfer_payee_id) return account.transfer_payee_id;
  const linked = await store.listPayeesLinkedTo(db, budgetId, accountId);
  const canonical = pickCanonical(null, linked);
  if (canonical) return canonical.id;
  return createTransferPayee(db, account);
}

export interface AbsorbResult {
  transactions: number;
  ruleMoved: boolean;
  /** What was lost: the source's renaming rule or "treat as transfer" rule the kept payee could not take. */
  dropped: { kind: 'rename_rule' | 'transfer_rule'; payee_id: string; payee_name: string; detail: string }[];
}

/**
 * REPAIR ONLY. Fold a duplicate payee into the canonical one: every reference
 * (transactions, splits, scheduled rows, repeat rules, link records, account
 * pointers; each scoped to the budget) moves, the renaming rule and the "treat
 * as transfer" rule move when the canonical payee has none, then the duplicate
 * row is deleted. What cannot move (a payee holds one rule) is returned so the
 * report can name it.
 */
export async function absorbPayee(db: Queryable, budgetId: string, fromId: string, intoId: string): Promise<AbsorbResult> {
  const from = await store.getPayeeRow(db, budgetId, fromId);
  const into = await store.getPayeeRow(db, budgetId, intoId);
  const result: AbsorbResult = { transactions: 0, ruleMoved: false, dropped: [] };
  if (!from || !into || from.id === into.id) return result;
  result.transactions = await store.repointPayeeReferences(db, budgetId, from.id, into.id);
  if (from.rename_condition !== null && from.rename_match_type !== null) {
    await store.clearRenameRule(db, from.id);
    if (into.rename_condition === null) {
      await store.setRenameRule(db, into.id, from.rename_match_type, from.rename_condition);
      result.ruleMoved = true;
    } else if (into.rename_condition !== from.rename_condition || into.rename_match_type !== from.rename_match_type) {
      result.dropped.push({
        kind: 'rename_rule',
        payee_id: from.id,
        payee_name: from.name,
        detail: `${from.rename_match_type} "${from.rename_condition}"`,
      });
    }
  }
  if (from.transfer_rule !== null) {
    if (into.transfer_rule === null) await store.copyTransferRule(db, from.id, into.id);
    else if (into.transfer_rule !== from.transfer_rule) {
      result.dropped.push({ kind: 'transfer_rule', payee_id: from.id, payee_name: from.name, detail: from.transfer_rule });
    }
  }
  await store.deletePayeeRow(db, budgetId, from.id);
  return result;
}

export interface TransferPayeeRename {
  payee_id: string;
  /** The name now held. */
  name: string;
  /** Set when the account's plain name was held by another payee: that payee is untouched, this one got a numbered name. */
  collision: { wanted: string; holder_payee_id: string; holder_account_id: string | null } | null;
  /** The account's pointer names a payee that does not point back at it: nothing was renamed, the repair fixes it. */
  inconsistent?: boolean;
}

/**
 * Bring the account's transfer payee in line with the account's CURRENT name
 * (call after the account row was renamed, in the same transaction). Same
 * payee id, new name. It touches no other payee: a name held by anything
 * else (another account's payee, an ordinary payee, a leftover) is skipped
 * and the payee takes the next numbered name; the collision is returned for
 * the caller to log, and the repair resolves it later. A concurrent insert of
 * the wanted name is retried with the next name instead of failing.
 */
export async function renameTransferPayee(db: Queryable, budgetId: string, accountId: string): Promise<TransferPayeeRename> {
  let payeeId = await ensureTransferPayee(db, budgetId, accountId);
  const account = (await store.getAccountRow(db, accountId))!;
  const own = await store.getPayeeRow(db, budgetId, payeeId);
  if (own?.transfer_account_id !== accountId) {
    // Never rename a payee that belongs to another account (or to none).
    const canonical = pickCanonical(null, await store.listPayeesLinkedTo(db, budgetId, accountId));
    if (!canonical) return { payee_id: payeeId, name: own?.name ?? '', collision: null, inconsistent: true };
    payeeId = canonical.id;
  }
  let collision: TransferPayeeRename['collision'] = null;
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
    const name = transferPayeeCandidate(account.name, n);
    const holder = await store.findPayeeRowByName(db, budgetId, name);
    if (holder?.id === payeeId) return { payee_id: payeeId, name, collision };
    if (holder) {
      if (n === 1) collision = { wanted: name, holder_payee_id: holder.id, holder_account_id: holder.transfer_account_id };
      continue;
    }
    if (await store.trySetPayeeName(db, payeeId, name)) return { payee_id: payeeId, name, collision };
  }
  throw new HttpError(409, 'no free transfer payee name for this account', 'conflict');
}

/**
 * Which account a payee TEXT means, read-only: null when it means none.
 *  - A "Transfer : <name>" text means the live account called <name>; when
 *    several share the name, the NEWEST (what the released client got before
 *    transfer payees were per account: the last account created took the one
 *    shared "Transfer : <name>" payee). The others are reached by payee id.
 *  - A text that is exactly the name of an account's payee (numbered names
 *    included, or a renaming rule's target) means that payee's account.
 * `exactFirst` (the text came out of a renaming rule, so it IS a payee's name)
 * tries the exact payee name before the account name.
 * Only texts that read "Transfer : ..." can mean an account.
 */
export async function resolveTransferAccountFromText(
  db: Queryable,
  budgetId: string,
  text: string,
  opts: { exactFirst?: boolean } = {},
): Promise<string | null> {
  const peerName = TRANSFER_PAYEE_RE.exec(text)?.[1]?.trim();
  if (!peerName) return null;
  const byExactPayee = async () => {
    const exact = await store.findPayeeRowByName(db, budgetId, text);
    if (!exact?.transfer_account_id || exact.deleted) return null;
    const account = await store.getAccountRow(db, exact.transfer_account_id);
    return account && account.budget_id === budgetId && !account.deleted ? account.id : null;
  };
  const byAccountName = async () => {
    const ids = await store.liveAccountIdsByName(db, budgetId, peerName);
    return ids.length > 0 ? ids[ids.length - 1]! : null;
  };
  const order = opts.exactFirst ? [byExactPayee, byAccountName] : [byAccountName, byExactPayee];
  for (const attempt of order) {
    const accountId = await attempt();
    if (accountId) return accountId;
  }
  return null;
}

/**
 * The payee id a payee TEXT means when it names an account (see
 * `resolveTransferAccountFromText`): that account's transfer payee, created if
 * the account has none. Null for any other text: the caller treats it as an
 * ordinary payee name.
 */
export async function resolveTransferPayeeText(
  db: Queryable,
  budgetId: string,
  text: string,
  opts: { exactFirst?: boolean } = {},
): Promise<string | null> {
  const accountId = await resolveTransferAccountFromText(db, budgetId, text, opts);
  return accountId ? ensureTransferPayee(db, budgetId, accountId) : null;
}
