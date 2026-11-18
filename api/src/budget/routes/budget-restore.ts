/**
 * POST /budgets/restore?budget_id=<uuid> — full budget restore (budget backup).
 *
 * The client uploads a parsed budget backup payload: the restore wipes every
 * budget-scoped data table (accounts, category groups/categories, payees,
 * transactions, splits, assignments, notes, targets, repeat rules) and
 * re-creates the payload inside one transaction. Indexes in the payload
 * (groupIndex / categoryIndex / accountIndex / categoryIndex / transferPeerIndex)
 * resolve against the order the payload itself declares.
 *
 * Money arrives as MILLIUNITS (format_version 2), like storage. A legacy
 * backup (format_version 1 or absent: the original syscd format, in CENTS) is
 * upgraded first by `upgradeRestorePayload`, so old backup files still restore.
 * Balance columns on accounts (cleared/uncleared) are a delta-maintained
 * cache that the backup does not carry; they are recomputed from the restored
 * transactions before commit (recomputeAccountBalances).
 */

import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError, errorResponse } from '../../core/validate';
import type { IdentityUser } from '../../user';
import { budgetRestore } from '@shared/contracts/budget';
import { upgradeRestorePayload } from '@shared/contracts/budget/schemas';
import { recomputeAccountBalances } from '../domain/transactions';
import { isBudgetMember, isBudgetOwnerOrAdmin } from '../ownership';
import { budgetRouter } from '../router';
import {
  budgetExists,
  insertRestoredAccount,
  insertRestoredAssignment,
  insertRestoredBundle,
  insertRestoredCategory,
  insertRestoredGroup,
  insertRestoredTransaction,
  linkRestoredTransferPayees,
  linkRestoredTransferPeer,
  upsertRestoredPayee,
  wipeBudgetData,
} from '../store/restore';

// Restore means "replace everything with mine": every incoming row is approved.
// Flags arrive as '' | color | free label — the storage split is flag_color for
// colors, flag_name for labels, NULL for ''.
const FLAG_COLORS: Record<string, true> = {
  red: true,
  orange: true,
  yellow: true,
  green: true,
  blue: true,
  purple: true,
};
const isFlagColor = (flag: string): boolean => flag in FLAG_COLORS;

export const operations = [
  implement(budgetRestore, async (c, { budget_id: budgetId, ...input }) => {
    const payload = upgradeRestorePayload(input);
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return errorResponse(c, 401, 'unauthorized');
    if (!(await isBudgetOwnerOrAdmin(user, budgetId))) return errorResponse(c, 404, 'not found');

    return withTransaction(pool, async (client) => {

      // Budget must exist; budgetAccess already proved ownership for non-admins.
      if (!(await budgetExists(client, budgetId))) throw new HttpError(404, 'budget not found');

      await wipeBudgetData(client, budgetId);

      // ---- category groups --------------------------------------------------
      const groupIds = payload.groups.map(() => crypto.randomUUID());
      for (let i = 0; i < payload.groups.length; i++) {
        await insertRestoredGroup(client, groupIds[i], budgetId, payload.groups[i], i);
      }

      // A backup may come from another budget: a person who is not a member of
      // THIS budget is dropped back to Shared (null) rather than rejected.
      const memberOk = new Map<string, boolean>();
      async function personFor(userId: string | null | undefined): Promise<string | null> {
        if (!userId) return null;
        if (!memberOk.has(userId)) memberOk.set(userId, await isBudgetMember(budgetId, userId, client));
        return memberOk.get(userId) ? userId : null;
      }

      // ---- bundles -----------------------------------------------------------
      const bundles = payload.bundles ?? [];
      const bundleIds = bundles.map(() => crypto.randomUUID());
      for (let i = 0; i < bundles.length; i++) {
        if (bundles[i].groupIndex >= payload.groups.length) {
          throw new HttpError(400, `bundle ${i}: groupIndex ${bundles[i].groupIndex} out of range`);
        }
        await insertRestoredBundle(client, bundleIds[i], budgetId, groupIds[bundles[i].groupIndex], bundles[i].name);
      }

      // ---- categories --------------------------------------------------------
      const categoryIds = payload.categories.map(() => crypto.randomUUID());
      for (let i = 0; i < payload.categories.length; i++) {
        const cat = payload.categories[i];
        if (cat.groupIndex >= payload.groups.length) {
          throw new HttpError(400, `category ${i}: groupIndex ${cat.groupIndex} out of range`);
        }
        const bundleIndex = cat.bundleIndex ?? null;
        if (bundleIndex !== null && (bundleIndex >= bundles.length || bundles[bundleIndex].groupIndex !== cat.groupIndex)) {
          throw new HttpError(400, `category ${i}: bundleIndex ${bundleIndex} is out of range or in another group`);
        }
        await insertRestoredCategory(client, {
          id: categoryIds[i],
          budgetId,
          groupId: groupIds[cat.groupIndex],
          name: cat.name,
          sortOrder: i,
          hidden: cat.hidden ?? false,
          userId: await personFor(cat.userId),
          bundleId: bundleIndex === null ? null : bundleIds[bundleIndex],
        });
      }

      // ---- accounts ----------------------------------------------------------
      const accountIds = payload.accounts.map(() => crypto.randomUUID());
      for (let i = 0; i < payload.accounts.length; i++) {
        await insertRestoredAccount(
          client,
          accountIds[i],
          budgetId,
          payload.accounts[i].name,
          await personFor(payload.accounts[i].userId),
          payload.accounts[i].currency ?? null,
        );
      }

      // ---- payees ------------------------------------------------------------
      // Resolve-or-create by trimmed name, deduplicated within the payload.
      // Mirrors the app's per-account "Transfer : <name>" payee convention so
      // transfer rows keep their picker entry.
      const payeeIdByName = new Map<string, string>();
      async function payeeFor(name: string): Promise<string | null> {
        const key = name.trim();
        if (key === '') return null;
        const known = payeeIdByName.get(key);
        if (known) return known;
        const id = await upsertRestoredPayee(client, crypto.randomUUID(), budgetId, key);
        payeeIdByName.set(key, id);
        return id;
      }

      // ---- transactions ------------------------------------------------------
      // Amounts: signed milliunits. Peer indexes resolve after the batch so the
      // two legs of a transfer link regardless of insert order.
      const txnIds = payload.transactions.map(() => crypto.randomUUID());
      for (let i = 0; i < payload.transactions.length; i++) {
        const txn = payload.transactions[i];
        if (txn.accountIndex >= payload.accounts.length) {
          throw new HttpError(400, `transaction ${i}: accountIndex ${txn.accountIndex} out of range`);
        }
        if (txn.categoryIndex !== null && txn.categoryIndex >= payload.categories.length) {
          throw new HttpError(400, `transaction ${i}: categoryIndex ${txn.categoryIndex} out of range`);
        }
        if (txn.transferPeerIndex !== null && txn.transferPeerIndex >= payload.transactions.length) {
          throw new HttpError(400, `transaction ${i}: transferPeerIndex ${txn.transferPeerIndex} out of range`);
        }

        const peerAccountName =
          txn.transferPeerIndex !== null
            ? payload.accounts[payload.transactions[txn.transferPeerIndex].accountIndex].name
            : null;
        const payeeName = txn.payee === '' && peerAccountName ? `Transfer : ${peerAccountName}` : txn.payee;
        const payeeId = await payeeFor(payeeName);

        const flag = txn.flag === '' ? null : txn.flag;
        await insertRestoredTransaction(client, {
          id: txnIds[i],
          budgetId,
          accountId: accountIds[txn.accountIndex],
          date: txn.date,
          amount: txn.inflow - txn.outflow,
          payeeId,
          categoryId: txn.categoryIndex === null ? null : categoryIds[txn.categoryIndex],
          memo: txn.memo,
          cleared: txn.cleared,
          flagColor: isFlagColor(txn.flag) ? flag : null,
          flagName: isFlagColor(txn.flag) ? null : flag,
        });
      }
      for (let i = 0; i < payload.transactions.length; i++) {
        const peer = payload.transactions[i].transferPeerIndex;
        if (peer === null) continue;
        if (payload.transactions[peer].transferPeerIndex !== i) {
          throw new HttpError(400, `transaction ${i}: transferPeerIndex ${peer} is not mutual`);
        }
        await linkRestoredTransferPeer(client, txnIds[i], txnIds[peer]);
      }

      // "Transfer : <account>" payees keep their picker linkage to the account,
      // mirroring the app's per-account transfer payee convention.
      await linkRestoredTransferPayees(client, budgetId);

      // ---- assignments -------------------------------------------------------
      for (const assignment of payload.assignments) {
        if (assignment.categoryIndex >= payload.categories.length) {
          throw new HttpError(400, `assignment: categoryIndex ${assignment.categoryIndex} out of range`);
        }
        await insertRestoredAssignment(
          client,
          crypto.randomUUID(),
          budgetId,
          assignment.month,
          categoryIds[assignment.categoryIndex],
          assignment.budgeted,
        );
      }

      // Balances are a cached value maintained by per-write deltas; the bulk
      // inserts above bypass that path, so rebuild them from the restored ledger.
      await recomputeAccountBalances(client, budgetId);

      return {
        groups: payload.groups.length,
        categories: payload.categories.length,
        accounts: payload.accounts.length,
        transactions: payload.transactions.length,
        assignments: payload.assignments.length,
      };
    });
  }),
];

// Owner-or-admin scoping like every budget-data route (USER-05) comes from budgetRouter.
export default budgetRouter('/budgets/restore', operations);
