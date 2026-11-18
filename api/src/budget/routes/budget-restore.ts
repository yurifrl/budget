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
 * Money arrives as client-side CENTS; storage is signed MILLIUNITS (x10).
 * Balance columns on accounts (cleared/uncleared) are a delta-maintained
 * cache that the backup does not carry; they are recomputed from the restored
 * transactions before commit (recomputeAccountBalances).
 */

import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import type { IdentityUser } from '../../user';
import { budgetRestore } from '@shared/contracts/budget';
import { recomputeAccountBalances } from '../domain/transactions';
import { isBudgetMember, isBudgetOwnerOrAdmin } from '../ownership';
import { budgetRouter } from '../router';

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

/** Tables wiped before the payload is re-created. Child-first order. */
const WIPE_TABLES = [
  'subtransactions',
  'transactions',
  'txn_repeat_rules',
  'scheduled_subtransactions',
  'scheduled_transactions',
  'assignments',
  'category_targets',
  'category_notes',
  'month_notes',
  'categories',
  'category_bundles',
  'category_groups',
  'accounts',
  'payee_locations',
  'payees',
] as const;

export const operations = [
  implement(budgetRestore, async (c, { budget_id: budgetId, ...payload }) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    if (!(await isBudgetOwnerOrAdmin(user, budgetId))) return c.json({ error: 'not found' }, 404);

    return withTransaction(pool, async (client) => {

      // Budget must exist; budgetAccess already proved ownership for non-admins.
      const budget = await client.query('SELECT 1 FROM budgets WHERE id = $1', [budgetId]);
      if (budget.rowCount === 0) throw new HttpError(404, 'budget not found');

      for (const table of WIPE_TABLES) {
        await client.query(`DELETE FROM public.${table} WHERE budget_id = $1`, [budgetId]);
      }

      // ---- category groups --------------------------------------------------
      const groupIds = payload.groups.map(() => crypto.randomUUID());
      for (let i = 0; i < payload.groups.length; i++) {
        await client.query(
          `INSERT INTO public.category_groups (id, budget_id, name, sort_order)
         VALUES ($1, $2, $3, $4)`,
          [groupIds[i], budgetId, payload.groups[i], i],
        );
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
        await client.query(
          'INSERT INTO public.category_bundles (id, budget_id, group_id, name) VALUES ($1, $2, $3, $4)',
          [bundleIds[i], budgetId, groupIds[bundles[i].groupIndex], bundles[i].name],
        );
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
        await client.query(
          `INSERT INTO public.categories (id, budget_id, group_id, name, sort_order, hidden, user_id, bundle_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            categoryIds[i],
            budgetId,
            groupIds[cat.groupIndex],
            cat.name,
            i,
            cat.hidden ?? false,
            await personFor(cat.userId),
            bundleIndex === null ? null : bundleIds[bundleIndex],
          ],
        );
      }

      // ---- accounts ----------------------------------------------------------
      const accountIds = payload.accounts.map(() => crypto.randomUUID());
      for (let i = 0; i < payload.accounts.length; i++) {
        await client.query(
          `INSERT INTO public.accounts (id, budget_id, name, type, account_group, user_id)
         VALUES ($1, $2, $3, 'checking', 'CASH', $4)`,
          [accountIds[i], budgetId, payload.accounts[i].name, await personFor(payload.accounts[i].userId)],
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
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO public.payees (id, budget_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (budget_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
          [crypto.randomUUID(), budgetId, key],
        );
        payeeIdByName.set(key, inserted.rows[0].id);
        return inserted.rows[0].id;
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
        await client.query(
          `INSERT INTO public.transactions
          (id, budget_id, account_id, date, amount, payee_id, category_id, memo,
           cleared, approved, flag_color, flag_name, repeat, deleted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, 'never', false)`,
          [
            txnIds[i],
            budgetId,
            accountIds[txn.accountIndex],
            txn.date,
            (txn.inflow - txn.outflow) * 10,
            payeeId,
            txn.categoryIndex === null ? null : categoryIds[txn.categoryIndex],
            txn.memo,
            txn.cleared,
            isFlagColor(txn.flag) ? flag : null,
            isFlagColor(txn.flag) ? null : flag,
          ],
        );
      }
      for (let i = 0; i < payload.transactions.length; i++) {
        const peer = payload.transactions[i].transferPeerIndex;
        if (peer === null) continue;
        if (payload.transactions[peer].transferPeerIndex !== i) {
          throw new HttpError(400, `transaction ${i}: transferPeerIndex ${peer} is not mutual`);
        }
        await client.query('UPDATE public.transactions SET transfer_transaction_id = $1 WHERE id = $2', [
          txnIds[peer],
          txnIds[i],
        ]);
      }

      // "Transfer : <account>" payees keep their picker linkage to the account,
      // mirroring the app's per-account transfer payee convention.
      await client.query(
        `UPDATE public.payees p SET transfer_account_id = a.id
       FROM public.accounts a
       WHERE p.budget_id = $1 AND p.name = 'Transfer : ' || a.name`,
        [budgetId],
      );

      // ---- assignments -------------------------------------------------------
      for (const assignment of payload.assignments) {
        if (assignment.categoryIndex >= payload.categories.length) {
          throw new HttpError(400, `assignment: categoryIndex ${assignment.categoryIndex} out of range`);
        }
        await client.query(
          `INSERT INTO public.assignments (id, budget_id, month, category_id, budgeted)
         VALUES ($1, $2, $3, $4, $5)`,
          [
            crypto.randomUUID(),
            budgetId,
            assignment.month,
            categoryIds[assignment.categoryIndex],
            assignment.budgeted * 10,
          ],
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
