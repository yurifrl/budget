/**
 * POST /budgets/restore?budget_id=<uuid> — budget restore (budget backup).
 *
 * `sections` ('plan' | 'register', default both) limits what is replaced; see
 * domain/restore-scope.ts for how the two sections depend on each other.
 * The text below describes the default, full restore.
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
import { TRANSFER_PAYEE_RE } from '@shared/domain/transfers';
import { matchCategoryIds, restoreScope } from '../domain/restore-scope';
import { ensureTransferPayee } from '../domain/transfer-payees';
import { recomputeAccountBalances } from '../domain/transactions';
import { isBudgetMember, isBudgetOwner } from '../ownership';
import { budgetRouter } from '../router';
import {
  budgetExists,
  insertRestoredAccount,
  insertRestoredAssignment,
  insertRestoredBundle,
  insertRestoredCategory,
  insertRestoredGroup,
  insertRestoredTransaction,
  listCategoryKeys,
  linkRestoredTransferPeer,
  relinkCategoryLinks,
  snapshotCategoryLinks,
  upsertRestoredPayee,
  wipeBudgetData,
  wipePlanData,
  wipeRegisterData,
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
    const { sections, ...body } = input;
    const payload = upgradeRestorePayload(body);
    const scope = restoreScope(sections);
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return errorResponse(c, 401, 'unauthorized');
    if (!(await isBudgetOwner(user.id, budgetId))) return errorResponse(c, 404, 'not found');

    return withTransaction(pool, async (client) => {

      // Budget must exist (the owner check above already proved it).
      if (!(await budgetExists(client, budgetId))) throw new HttpError(404, 'budget not found');

      // Wipe only what the scope replaces. A plan-only restore first remembers
      // which category (group+name) each surviving register row used.
      if (scope.plan && scope.register) await wipeBudgetData(client, budgetId);
      else if (scope.plan) {
        await snapshotCategoryLinks(client, budgetId);
        await wipePlanData(client, budgetId);
      } else {
        await wipeRegisterData(client, budgetId);
      }

      // Register-only: the plan stays, payload categories only name the targets.
      const matchedCategoryIds = scope.plan
        ? null
        : matchCategoryIds(payload.groups, payload.categories, await listCategoryKeys(client, budgetId));

      // ---- category groups --------------------------------------------------
      const groupIds = payload.groups.map(() => crypto.randomUUID());
      for (let i = 0; scope.plan && i < payload.groups.length; i++) {
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
      const bundles = scope.plan ? (payload.bundles ?? []) : [];
      const bundleIds = bundles.map(() => crypto.randomUUID());
      for (let i = 0; i < bundles.length; i++) {
        if (bundles[i].groupIndex >= payload.groups.length) {
          throw new HttpError(400, `bundle ${i}: groupIndex ${bundles[i].groupIndex} out of range`, 'invalid_backup');
        }
        await insertRestoredBundle(client, bundleIds[i], budgetId, groupIds[bundles[i].groupIndex], bundles[i].name);
      }

      // ---- categories --------------------------------------------------------
      const categoryIds = payload.categories.map(() => crypto.randomUUID());
      for (let i = 0; scope.plan && i < payload.categories.length; i++) {
        const cat = payload.categories[i];
        if (cat.groupIndex >= payload.groups.length) {
          throw new HttpError(400, `category ${i}: groupIndex ${cat.groupIndex} out of range`, 'invalid_backup');
        }
        const bundleIndex = cat.bundleIndex ?? null;
        if (bundleIndex !== null && (bundleIndex >= bundles.length || bundles[bundleIndex].groupIndex !== cat.groupIndex)) {
          throw new HttpError(400, `category ${i}: bundleIndex ${bundleIndex} is out of range or in another group`, 'invalid_backup');
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
      for (let i = 0; scope.register && i < payload.accounts.length; i++) {
        await insertRestoredAccount(
          client,
          accountIds[i],
          budgetId,
          payload.accounts[i].name,
          await personFor(payload.accounts[i].userId),
          payload.accounts[i].currency ?? null,
        );
        // Every restored account gets its own transfer payee, by id: two
        // accounts with the same name each keep theirs.
        await ensureTransferPayee(client, budgetId, accountIds[i], payload.accounts[i].name);
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
      const transactions = scope.register ? payload.transactions : [];
      const txnIds = transactions.map(() => crypto.randomUUID());
      let uncategorized = 0;
      for (let i = 0; i < transactions.length; i++) {
        const txn = transactions[i];
        if (txn.accountIndex >= payload.accounts.length) {
          throw new HttpError(400, `transaction ${i}: accountIndex ${txn.accountIndex} out of range`, 'invalid_backup');
        }
        if (txn.categoryIndex !== null && txn.categoryIndex >= payload.categories.length) {
          throw new HttpError(400, `transaction ${i}: categoryIndex ${txn.categoryIndex} out of range`, 'invalid_backup');
        }
        if (txn.transferPeerIndex !== null && txn.transferPeerIndex >= payload.transactions.length) {
          throw new HttpError(400, `transaction ${i}: transferPeerIndex ${txn.transferPeerIndex} out of range`, 'invalid_backup');
        }

        // A transfer leg whose payee is empty or reads "Transfer : <name>" takes
        // the PEER account's transfer payee, by account (not by name: accounts
        // may share a name).
        const peerAccountIndex =
          txn.transferPeerIndex !== null ? payload.transactions[txn.transferPeerIndex].accountIndex : null;
        const payeeId =
          peerAccountIndex !== null && (txn.payee === '' || TRANSFER_PAYEE_RE.test(txn.payee))
            ? await ensureTransferPayee(client, budgetId, accountIds[peerAccountIndex])
            : await payeeFor(txn.payee);

        // Restored accounts are all on budget: a transfer leg carries no category.
        const categoryId =
          txn.categoryIndex === null || txn.transferPeerIndex !== null
            ? null
            : matchedCategoryIds
              ? matchedCategoryIds[txn.categoryIndex]
              : categoryIds[txn.categoryIndex];
        if (matchedCategoryIds && txn.categoryIndex !== null && txn.transferPeerIndex === null && categoryId === null) uncategorized++;

        const flag = txn.flag === '' ? null : txn.flag;
        await insertRestoredTransaction(client, {
          id: txnIds[i],
          budgetId,
          accountId: accountIds[txn.accountIndex],
          date: txn.date,
          amount: txn.inflow - txn.outflow,
          payeeId,
          categoryId,
          memo: txn.memo,
          cleared: txn.cleared,
          flagColor: isFlagColor(txn.flag) ? flag : null,
          flagName: isFlagColor(txn.flag) ? null : flag,
        });
      }
      for (let i = 0; i < transactions.length; i++) {
        const peer = transactions[i].transferPeerIndex;
        if (peer === null) continue;
        if (transactions[peer].transferPeerIndex !== i) {
          throw new HttpError(400, `transaction ${i}: transferPeerIndex ${peer} is not mutual`, 'invalid_backup');
        }
        await linkRestoredTransferPeer(client, txnIds[i], txnIds[peer], accountIds[transactions[peer].accountIndex]);
      }

      // ---- assignments -------------------------------------------------------
      const assignments = scope.plan ? payload.assignments : [];
      for (const assignment of assignments) {
        if (assignment.categoryIndex >= payload.categories.length) {
          throw new HttpError(400, `assignment: categoryIndex ${assignment.categoryIndex} out of range`, 'invalid_backup');
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
      if (scope.register) await recomputeAccountBalances(client, budgetId);
      // Plan-only: hand surviving register rows to the restored categories.
      if (!scope.register) await relinkCategoryLinks(client, budgetId);

      return {
        groups: scope.plan ? payload.groups.length : 0,
        categories: scope.plan ? payload.categories.length : 0,
        accounts: scope.register ? payload.accounts.length : 0,
        transactions: transactions.length,
        assignments: assignments.length,
        uncategorized,
      };
    });
  }),
];

// Owner-or-member scoping comes from budgetRouter (USER-05); the handler then requires the owner.
export default budgetRouter('/budgets/restore', operations);
