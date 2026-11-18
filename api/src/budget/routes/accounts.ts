import { pool, withTransaction, type Queryable } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { accountsCreate, accountsDelete, accountsList, accountsReconcile, accountsUpdate } from '@shared/contracts/budget';
import type { AccountType } from '@shared/contracts/budget/schemas';
import { ensureTransferPayee } from '../domain/transfers';
import { toPersonRef } from '../../user';
import { findUserConnection } from '../../connections';
import { isBudgetMember } from '../ownership';
import { budgetRouter } from '../router';
import * as accountsStore from '../store/accounts';
import { findOrCreatePayeeByName, repointLiveTransactionsPayee, retireTransferPayee } from '../store/payees';

const CREDIT_TYPES: Partial<Record<AccountType, true>> = { creditCard: true, lineOfCredit: true };

/** Debt types mirror a negative balance at creation (YNAB starts loans at the amount owed). */
const DEBT_TYPES: Partial<Record<AccountType, true>> = {
  otherLiability: true,
  mortgage: true,
  autoLoan: true,
  studentLoan: true,
  personalLoan: true,
  medicalDebt: true,
  otherDebt: true,
};

/** 400 unless `userId` (non-null) is a member of the account's budget. */
async function assertMemberOrShared(
  client: Parameters<typeof isBudgetMember>[2],
  budgetId: string,
  userId: string | null | undefined,
): Promise<void> {
  if (userId == null) return;
  if (!(await isBudgetMember(budgetId, userId, client))) {
    throw new HttpError(400, 'user_id is not a member of this budget');
  }
}

const accountGroupFor = (type: AccountType): 'CASH' | 'CREDIT' => (CREDIT_TYPES[type] ? 'CREDIT' : 'CASH');

/**
 * YNAB parity: a card account owns a payment category (same name) in the
 * budget's Credit Card Payments group. Creates the group when missing and the
 * category unless a live one with that name already exists there. No money is
 * assigned. The engine links card to category by exact name (spec P8).
 */
async function ensureCardPaymentCategory(client: Queryable, budgetId: string, name: string): Promise<void> {
  let groupId = await accountsStore.findCardPaymentsGroup(client, budgetId);
  if (!groupId) {
    groupId = await accountsStore.insertCardPaymentsGroup(client, budgetId);
  }
  await accountsStore.insertCardPaymentCategoryIfMissing(client, budgetId, groupId, name);
}

const createAccount = implement(
  accountsCreate,
  async (_c, { budget_id, name, type, on_budget, balance, user_id, currency }) => {
    const accountId = await withTransaction(pool, async (client) => {
      if (!(await accountsStore.budgetExists(client, budget_id))) throw new HttpError(404, 'budget not found');

      await assertMemberOrShared(client, budget_id, user_id);

      // Open accounts start with an explicit positive/negative opening transaction,
      // so keep the stored balances at 0 and let that transaction carry the amount.
      const accountId = await accountsStore.insertAccount(client, {
        budgetId: budget_id,
        name,
        type,
        accountGroup: accountGroupFor(type),
        onBudget: on_budget,
        userId: user_id ?? null,
        currency: currency ?? null,
      });
      // Every account gets its "Transfer : <name>" payee so it shows up in the
      // register's Payments and Transfers list and can be a transfer target.
      await ensureTransferPayee(client, budget_id, accountId, name);
      if (type === 'creditCard' && on_budget) await ensureCardPaymentCategory(client, budget_id, name);

      if (balance !== 0) {
        // Positive opening balance = inflow; debt types flip the sign so the
        // account starts at the amount owed (balance is stated |balance|).
        const deltaMilli = DEBT_TYPES[type] ? -balance : balance;
        const payeeId = await findOrCreatePayeeByName(client, budget_id, 'Starting Balance');
        await accountsStore.insertOpeningBalanceTransaction(client, budget_id, accountId, payeeId, deltaMilli);
        await accountsStore.setUnclearedBalance(client, accountId, deltaMilli);
      }

      return accountId;
    });
    // Read back after COMMIT (as before the withTransaction refactor).
    return accountsStore.getAccount(pool, accountId);
  },
);

const updateAccount = implement(
  accountsUpdate,
  async (c, { id: accountId, budget_id, name, note, closed, working_balance, link, user_id, currency }) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized');
    await withTransaction(pool, async (client) => {
      const acc = await accountsStore.getAccountForUpdateCheck(client, accountId);
      // Scope every write by the budget in the body — same cross-budget guard
      // the reconcile route uses.
      if (!acc || acc.budget_id !== budget_id) {
        throw new HttpError(404, 'account not found');
      }

      // Closed accounts are immutable (YNAB parity): field edits are rejected
      // until the request reopens the account (closed === false). Reopen may
      // carry the same fields — that is the documented one-save reopen.
      const isClosed = acc.closed;
      const mutatesFields =
        name !== undefined ||
        note !== undefined ||
        working_balance !== undefined ||
        user_id !== undefined ||
        currency !== undefined ||
        link !== undefined;
      if (isClosed && closed !== false && mutatesFields) {
        throw new HttpError(409, 'account is closed — reopen it to make changes');
      }

      // Working-balance edit is an OVERRIDE, not a ledger operation (product
      // decision): the balance is set directly, no adjustment entry is booked.
      // The delta lands in the uncleared bucket — the balance stays unverified
      // until reconciled, and future ledger deltas keep applying on top.
      if (working_balance !== undefined) {
        const current = await accountsStore.getAccountBalances(client, accountId);
        const workingMilli = Number(current.cleared_balance) + Number(current.uncleared_balance);
        const diff = working_balance - workingMilli;
        if (diff !== 0) {
          await accountsStore.addToUnclearedBalance(client, accountId, diff);
        }
      }

      if (closed !== undefined) {
        // 0004 sync invariant: account_group tracks closed state.
        await accountsStore.setAccountClosed(client, accountId, closed);
      }

      if (name !== undefined && name !== acc.name && acc.type === 'creditCard' && acc.on_budget) {
        // Keep the name-linked payment category in step (live, in the CCP group, no clash).
        await accountsStore.renameCardPaymentCategory(client, budget_id, acc.name, name);
      }

      if (name !== undefined || note !== undefined) {
        await accountsStore.setAccountNameNote(client, accountId, name ?? null, note ?? null);
      }

      if (user_id !== undefined) {
        await assertMemberOrShared(client, budget_id, user_id);
        await accountsStore.setAccountUser(client, accountId, user_id);
      }

      // Currency is a label (G1): stored as given, no amounts are converted.
      if (currency !== undefined) {
        await accountsStore.setAccountCurrency(client, accountId, currency);
      }

      if (link !== undefined) {
        if (link.connectionId == null) {
          // Unlink: the account stays, it just loses its bank link.
          await accountsStore.unlinkAccount(client, accountId);
        } else {
          if (!link.externalAccountId) {
            throw new HttpError(400, 'link.externalAccountId is required when linking');
          }
          // The caller's own connection only: another user's connection id is
          // indistinguishable from a bogus one — 404 either way.
          const conn = await findUserConnection(client, link.connectionId, user.id);
          if (!conn) throw new HttpError(404, 'connection not found');
          // Strict 1:1: an upstream account may back only one budget account
          // (0021 unique index is the backstop — this check gives the 409).
          if (await accountsStore.findOtherAccountLinkedTo(client, accountId, link.connectionId, link.externalAccountId)) {
            throw new HttpError(409, `that bank account is already linked to another budget account`);
          }
          await accountsStore.linkAccount(
            client,
            accountId,
            link.connectionId,
            link.externalAccountId,
            link.institution ?? conn.institution,
          );
        }
      }

      return accountId;
    });
    // Read back after COMMIT (as before the withTransaction refactor).
    return accountsStore.getAccount(pool, accountId);
  },
);

const reconcileAccount = implement(
  accountsReconcile,
  async (_c, { id: accountId, budget_id, stated_balance, reconcile_all }) => {
    return withTransaction(pool, async (client) => {
      const acc = await accountsStore.getAccountBudgetClosed(client, accountId);
      // The account must exist AND belong to the budget in the request body;
      // otherwise the payee/adjustment rows below would be written cross-budget.
      if (!acc || acc.budget_id !== budget_id) {
        throw new HttpError(404, 'account not found');
      }
      // Closed accounts are immutable — balances can no longer change.
      if (acc.closed) {
        throw new HttpError(409, 'account is closed — reopen it to reconcile');
      }

      // YNAB's "Yes": the on-screen balance already matches the bank, so every
      // row — pending ones included — is known-good. Lock everything as
      // reconciled with no adjustment; the balance columns just fold the
      // uncleared remainder into cleared (totals unchanged).
      if (reconcile_all) {
        await accountsStore.reconcileAccountTransactions(client, accountId);
        await accountsStore.foldUnclearedIntoCleared(client, accountId);
        return;
      }

      // The stated balance is what the user has in the account: the target
      // WORKING balance (cleared + uncleared). Diff against the real ledger sum
      // (same live-row filter as recomputeAccountBalances; split legs are
      // separate rows that carry no amount into the sum) so a stale cache or a
      // working-balance override (no ledger row) is absorbed by the adjustment.
      const statedMilli = stated_balance;
      const diff = statedMilli - (await accountsStore.ledgerSum(client, accountId));

      if (diff !== 0) {
        const payeeId = await findOrCreatePayeeByName(client, budget_id, 'Reconciliation Adjustment');
        await accountsStore.insertReconciliationAdjustment(client, budget_id, accountId, payeeId, diff);
      }

      await accountsStore.reconcileAccountTransactions(client, accountId);
      await accountsStore.setReconciledBalance(client, accountId, statedMilli);
    });
  },
);

/**
 * DELETE /accounts/:id — delete a closed account and every transaction it
 * ever held. Soft-delete (0004 `deleted` flags) so restores stay possible;
 * the account vanishes from GET / (deleted = false) and its transfer payee
 * is retired with it.
 *
 * Peer transfer legs in other accounts stay (the money really left them) and
 * are re-pointed from the dead "Transfer : <name>" payee to a plain payee
 * named after the deleted account, so Ready-to-Assign math keeps treating
 * them as internal moves once the name no longer resolves as a transfer.
 * Balances are zeroed server-side — they already absorb every live row, so
 * zeroing is the exact reverse; no client delta contract like
 * DELETE /transactions/:id.
 */
const deleteAccount = implement(accountsDelete, async (_c, { id: accountId, budget_id: budgetId }) => {
  return withTransaction(pool, async (client) => {
    const acc = await accountsStore.lockLiveAccount(client, accountId);
    if (!acc || acc.budget_id !== budgetId) throw new HttpError(404, 'account not found');
    if (!acc.closed) throw new HttpError(409, 'account must be closed before it can be deleted');

    // Splits ride on the parent's deleted flag on read; soft-deleting the
    // parents suffices. Upcoming rows are ordinary transactions (repeat-rule
    // materializations) — they ride along and are never balance-moving, so
    // zeroing the account covers every bucket.
    await accountsStore.softDeleteAccountTransactions(client, accountId);

    // Repeat rules pointed at the account — as their home account or as the
    // target of a recurring transfer — would re-materialize rows into/for a
    // deleted account on their next tick. Retire them with it; their (already
    // soft-deleted) occurrences keep the rule reference via the FK, so rules
    // are flagged, never hard-deleted.
    await accountsStore.retireAccountRepeatRules(client, accountId, acc.transfer_payee_id);

    await accountsStore.zeroAndDeleteAccount(client, accountId);

    // Re-point surviving transfer legs to a plain payee named after the
    // deleted account (find-or-create, same mechanic as reconciliation's),
    // then retire the transfer payee — nothing live references it anymore and
    // a dangling "Transfer : <name>" would linger in Manage Payees.
    const plain = await findOrCreatePayeeByName(client, budgetId, acc.name);
    await repointLiveTransactionsPayee(client, acc.transfer_payee_id, plain);
    await retireTransferPayee(client, acc.transfer_payee_id);
  });
});

export const operations = [
  implement(accountsList, async (_c, { budget_id }) => {
    // linked_by: whoever owns the bank connection behind a linked account — a
    // budget member's name/email/avatar only, never the connection itself
    // (connections stay owner-scoped).
    const rows = await accountsStore.listAccountsWithLinker(pool, budget_id);
    return rows.map(({ ref_user_id, ref_name, ref_email, avatar_seed, avatar_image_version, ...account }) => ({
      ...account,
      linked_by: toPersonRef({ ref_user_id, ref_name, ref_email, avatar_seed, avatar_image_version }),
    }));
  }),
  createAccount,
  updateAccount,
  reconcileAccount,
  deleteAccount,
];

export default budgetRouter('/accounts', operations);
