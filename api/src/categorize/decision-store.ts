/**
 * SQL for the Categorize page's decisions: accept a batch, undo it, skip a
 * transaction. Accept and undo write the category through the SAME transaction
 * PATCH path as budget_transactions_update (`updateTransactionInClient`), so
 * ownership, the budget revision trigger, transfer/mirror handling and balance
 * derivation are shared, and each batch runs in ONE transaction (all-or-
 * nothing).
 */
import type { Pool } from 'pg';

import { categoryAssignability, updateTransactionInClient } from '../budget';
import { withTransaction, type Queryable } from '../core/db';
import { HttpError } from '../core/validate';
import { NEEDS_CATEGORY_FROM, NEEDS_CATEGORY_WHERE, pendingTransferIds } from './store';

export type DecisionItem = { transaction_id: string; category_id: string };

/** One scoped lock of a live transaction; 404 says nothing about whose budget it is. */
async function lockLiveTransaction(
  client: Queryable,
  budgetId: string,
  transactionId: string,
): Promise<{ category_id: string | null }> {
  const { rows } = await client.query<{ category_id: string | null }>(
    `select category_id from public.transactions
      where id = $1 and budget_id = $2 and deleted = false
      for update`,
    [transactionId, budgetId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'transaction not found');
  return row;
}

/**
 * Does the transaction still need a category by the register's rule? The
 * transfer-pending half comes from the same plan the queue uses.
 */
async function stillNeedsCategory(
  client: Queryable,
  budgetId: string,
  transactionId: string,
  pending: readonly string[],
): Promise<boolean> {
  const { rowCount } = await client.query(
    `select 1 ${NEEDS_CATEGORY_FROM} ${NEEDS_CATEGORY_WHERE} and t.id = $3`,
    [budgetId, pending, transactionId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Mark the person's choice: the pending suggestion of that category becomes
 * accepted and every other pending suggestion is dismissed. When the chosen
 * category was not among the suggestions, rank 1 is overwritten with a
 * `manual` accepted row (the freeze rule reads any non-pending row).
 */
async function settleSuggestions(
  client: Queryable,
  budgetId: string,
  transactionId: string,
  categoryId: string,
): Promise<void> {
  const matched = await client.query(
    `update public.category_suggestions
        set status = 'accepted', updated_at = now()
      where transaction_id = $1 and budget_id = $2 and status = 'pending' and category_id = $3`,
    [transactionId, budgetId, categoryId],
  );
  await client.query(
    `update public.category_suggestions
        set status = 'dismissed', updated_at = now()
      where transaction_id = $1 and budget_id = $2 and status = 'pending'`,
    [transactionId, budgetId],
  );
  if ((matched.rowCount ?? 0) > 0) return;
  await client.query(
    `insert into public.category_suggestions
       (transaction_id, budget_id, rank, category_id, confidence, reason, source, provider, model, status)
     values ($1, $2, 1, $3, 1, null, 'manual', null, null, 'accepted')
     on conflict (transaction_id, rank) do update
       set category_id = excluded.category_id, confidence = 1, reason = null,
           source = 'manual', provider = null, model = null, status = 'accepted', updated_at = now()`,
    [transactionId, budgetId, categoryId],
  );
}

/**
 * Categorize a batch atomically. Every category must be assignable in this
 * budget and every transaction must be live, in this budget, still needing a
 * category (or already carrying the requested one, which makes a repeat
 * succeed). Returns exactly the applied pairs for undo.
 */
export async function acceptCategories(
  pool: Pool,
  budgetId: string,
  items: readonly DecisionItem[],
  userId: string | null,
): Promise<{ accepted: number; items: DecisionItem[] }> {
  return withTransaction(pool, async (client) => {
    const pending = await pendingTransferIds(client, budgetId);

    for (const categoryId of new Set(items.map((item) => item.category_id))) {
      const check = await categoryAssignability(client, categoryId, budgetId);
      if (check === 'not_in_budget') throw new HttpError(400, 'category not found in budget', 'category_not_in_budget');
      if (check === 'not_assignable') {
        throw new HttpError(400, 'category cannot be used for categorization', 'category_not_assignable');
      }
    }

    let accepted = 0;
    for (const item of items) {
      const row = await lockLiveTransaction(client, budgetId, item.transaction_id);
      // The decision is read while the transaction is locked, so two accepts
      // (or an undo) cannot interleave between the check and the write.
      const decision = await client.query<{ category_id: string }>(
        `select category_id from public.categorize_decisions
          where transaction_id = $1 and budget_id = $2`,
        [item.transaction_id, budgetId],
      );
      if (decision.rows[0]) {
        // Idempotent only for a pair accept itself applied; another value
        // means a person (or another tab) changed it after this queue was read.
        if (decision.rows[0].category_id !== item.category_id) {
          throw new HttpError(409, 'transaction already has another category', 'categorize_already_categorized');
        }
        continue;
      }
      if (row.category_id !== null) {
        throw new HttpError(409, 'transaction already has a category', 'categorize_already_categorized');
      }
      if (!(await stillNeedsCategory(client, budgetId, item.transaction_id, pending))) {
        throw new HttpError(409, 'transaction no longer needs a category', 'categorize_not_needing_category');
      }
      // A skipped (or otherwise decided) transaction is frozen: accept must
      // not resurrect it, which also keeps undo's "previous status" = pending.
      const decided = await client.query(
        `select 1 from public.category_suggestions
          where transaction_id = $1 and budget_id = $2 and status <> 'pending' limit 1`,
        [item.transaction_id, budgetId],
      );
      if ((decided.rowCount ?? 0) > 0) {
        throw new HttpError(409, 'transaction already has a decision', 'categorize_already_categorized');
      }
      await updateTransactionInClient(client, {
        budgetId,
        id: item.transaction_id,
        patch: { category_id: item.category_id },
        subtransactions: undefined,
      });
      await client.query(
        `insert into public.categorize_decisions (transaction_id, budget_id, category_id, user_id)
         values ($1, $2, $3, $4)`,
        [item.transaction_id, budgetId, item.category_id, userId],
      );
      await settleSuggestions(client, budgetId, item.transaction_id, item.category_id);
      accepted += 1;
    }

    return { accepted, items: [...items] };
  });
}

export type UndoSkipReason = 'no_decision' | 'category_changed' | 'upcoming' | 'not_found';

/**
 * Reverse only what accept recorded. Undo trusts no client-supplied category:
 * it reads the decision row accept wrote, and reverts only while the
 * transaction still carries that category and is not an upcoming occurrence.
 * Everything else is left untouched and reported in `skipped` with a reason.
 * The whole batch is one transaction.
 */
export async function undoAccept(
  pool: Pool,
  budgetId: string,
  transactionIds: readonly string[],
): Promise<{
  restored: number;
  transaction_ids: string[];
  skipped: { transaction_id: string; reason: UndoSkipReason }[];
}> {
  return withTransaction(pool, async (client) => {
    const restored: string[] = [];
    const skipped: { transaction_id: string; reason: UndoSkipReason }[] = [];
    for (const transactionId of transactionIds) {
      const decision = await client.query<{ category_id: string }>(
        `select category_id from public.categorize_decisions
          where transaction_id = $1 and budget_id = $2
          for update`,
        [transactionId, budgetId],
      );
      const decided = decision.rows[0];
      if (!decided) {
        skipped.push({ transaction_id: transactionId, reason: 'no_decision' });
        continue;
      }
      const { rows } = await client.query<{ category_id: string | null; upcoming: boolean }>(
        `select category_id, upcoming from public.transactions
          where id = $1 and budget_id = $2 and deleted = false
          for update`,
        [transactionId, budgetId],
      );
      const row = rows[0];
      if (!row) {
        await client.query(
          `delete from public.categorize_decisions where transaction_id = $1 and budget_id = $2`,
          [transactionId, budgetId],
        );
        skipped.push({ transaction_id: transactionId, reason: 'not_found' });
        continue;
      }
      if (row.upcoming) {
        skipped.push({ transaction_id: transactionId, reason: 'upcoming' });
        continue;
      }
      // A hand-set or later-changed category is not accept's to undo.
      if (row.category_id !== decided.category_id) {
        skipped.push({ transaction_id: transactionId, reason: 'category_changed' });
        continue;
      }
      await updateTransactionInClient(client, {
        budgetId,
        id: transactionId,
        patch: { category_id: null },
        subtransactions: undefined,
      });
      await client.query(
        `delete from public.category_suggestions
          where transaction_id = $1 and budget_id = $2 and source = 'manual'`,
        [transactionId, budgetId],
      );
      await client.query(
        `update public.category_suggestions
            set status = 'pending', updated_at = now()
          where transaction_id = $1 and budget_id = $2 and source <> 'manual'`,
        [transactionId, budgetId],
      );
      await client.query(
        `delete from public.categorize_decisions where transaction_id = $1 and budget_id = $2`,
        [transactionId, budgetId],
      );
      restored.push(transactionId);
    }
    return { restored: restored.length, transaction_ids: restored, skipped };
  });
}

/**
 * Dismiss every pending suggestion of the transaction. A dismissed suggestion
 * freezes it (the engine never re-classifies it), so it leaves every member's
 * queue without a category. Repeating is a no-op; a transaction with nothing
 * to dismiss is a 409, because skip would not change its queue state.
 */
export async function skipTransaction(
  pool: Pool,
  budgetId: string,
  transactionId: string,
): Promise<{ dismissed: number }> {
  return withTransaction(pool, async (client) => {
    const row = await lockLiveTransaction(client, budgetId, transactionId);
    if (row.category_id !== null) {
      throw new HttpError(409, 'transaction already has a category', 'categorize_already_categorized');
    }
    const dismissed = await client.query(
      `update public.category_suggestions
          set status = 'dismissed', updated_at = now()
        where transaction_id = $1 and budget_id = $2 and status = 'pending'`,
      [transactionId, budgetId],
    );
    if ((dismissed.rowCount ?? 0) > 0) return { dismissed: dismissed.rowCount ?? 0 };
    const already = await client.query(
      `select 1 from public.category_suggestions
        where transaction_id = $1 and budget_id = $2 and status = 'dismissed' limit 1`,
      [transactionId, budgetId],
    );
    if ((already.rowCount ?? 0) > 0) return { dismissed: 0 };
    throw new HttpError(409, 'transaction has no suggestions to skip', 'categorize_nothing_to_skip');
  });
}
