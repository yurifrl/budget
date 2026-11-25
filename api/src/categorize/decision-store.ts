/**
 * SQL for the Categorize page's decisions: accept a batch (explicit items or a
 * server-resolved bundle), undo it, skip a transaction. Accept and undo write
 * the category through the SAME transaction PATCH path as
 * budget_transactions_update (`updateTransactionInClient`), so ownership, the
 * budget revision trigger, transfer/mirror handling and balance derivation are
 * shared, and each batch runs in ONE transaction (all-or-nothing).
 *
 * Accept records what it did in public.categorize_decisions; undo reverses only
 * that record, never a client-supplied category. Skip records a decision too,
 * so it survives and the queue can tell it from an accept.
 */
import type { Pool, PoolClient } from 'pg';

import { categoryAssignability, updateTransactionInClient } from '../budget';
import { withTransaction, type Queryable } from '../core/db';
import { HttpError } from '../core/validate';
import { bundleTransactionIds, type BundleKey } from './queue-store';
import { NEEDS_CATEGORY_FROM, NEEDS_CATEGORY_WHERE, NEEDS_CATEGORY_WHERE_IGNORING_CATEGORY, pendingTransferIds, restorePendingSuggestions } from './store';

export type DecisionItem = { transaction_id: string; category_id: string };
export type UndoSkipReason = 'no_decision' | 'category_changed' | 'upcoming' | 'skipped' | 'not_found';

type LockedTransaction = { category_id: string | null; upcoming: boolean };
type DecisionRow = { kind: string; category_id: string | null };

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
 * Lock every transaction of a batch in ONE statement ordered by id. This is
 * the deadlock-free order: two accepts (or an accept and an undo) with
 * overlapping ids in opposite request order still take their row locks in the
 * same order.
 */
async function lockLiveTransactions(
  client: Queryable,
  budgetId: string,
  transactionIds: readonly string[],
): Promise<Map<string, LockedTransaction>> {
  const ids = [...new Set(transactionIds)].sort();
  const { rows } = await client.query<{ id: string } & LockedTransaction>(
    `select id, category_id, upcoming from public.transactions
      where id = any($1::uuid[]) and budget_id = $2 and deleted = false
      order by id
      for update`,
    [ids, budgetId],
  );
  return new Map(rows.map(({ id, ...row }) => [id, row]));
}

/** Lock the batch's decision rows (ordered after the transactions, always). */
async function lockDecisions(
  client: Queryable,
  budgetId: string,
  transactionIds: readonly string[],
): Promise<Map<string, DecisionRow>> {
  const ids = [...new Set(transactionIds)].sort();
  const { rows } = await client.query<{ transaction_id: string } & DecisionRow>(
    `select transaction_id, kind, category_id from public.categorize_decisions
      where budget_id = $1 and transaction_id = any($2::uuid[])
      order by transaction_id
      for update`,
    [budgetId, ids],
  );
  return new Map(rows.map(({ transaction_id, ...row }) => [transaction_id, row]));
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
  ignoreCategory = false,
): Promise<boolean> {
  const where = ignoreCategory ? NEEDS_CATEGORY_WHERE_IGNORING_CATEGORY : NEEDS_CATEGORY_WHERE;
  const { rowCount } = await client.query(
    `select 1 ${NEEDS_CATEGORY_FROM} ${where} and t.id = $3`,
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
 * Apply explicit pairs inside the caller's transaction. Locks every
 * transaction first, then every decision row, both in id order. Returns the
 * pairs (unchanged) for the client's undo; `accepted` counts only new writes.
 */
async function acceptItems(
  client: PoolClient,
  budgetId: string,
  items: readonly DecisionItem[],
  userId: string | null,
  pending: readonly string[],
): Promise<{ accepted: number; items: DecisionItem[] }> {
  for (const categoryId of new Set(items.map((item) => item.category_id))) {
    const check = await categoryAssignability(client, categoryId, budgetId);
    if (check === 'not_in_budget') throw new HttpError(400, 'category not found in budget', 'category_not_in_budget');
    if (check === 'not_assignable') {
      throw new HttpError(400, 'category cannot be used for categorization', 'category_not_assignable');
    }
  }

  const ids = items.map((item) => item.transaction_id);
  const locked = await lockLiveTransactions(client, budgetId, ids);
  const decisions = await lockDecisions(client, budgetId, ids);

  let accepted = 0;
  for (const item of items) {
    const row = locked.get(item.transaction_id);
    if (!row) throw new HttpError(404, 'transaction not found');
    const decision = decisions.get(item.transaction_id);
    // An accept whose category is gone (the person cleared it by hand) is
    // STALE: no decision any more, so this accept replaces it. A skip still
    // freezes the row.
    const staleAccept = decision?.kind === 'accept' && row.category_id === null;
    if (!staleAccept && decision) {
      // Idempotent only for a pair accept itself applied; another value (or a
      // skip) means a person (or another tab) changed it after this queue was
      // read. A repeat never rewrites the model's suggestion.
      if (decision.kind === 'accept' && decision.category_id === item.category_id) continue;
      throw new HttpError(409, 'transaction already has a decision', 'categorize_already_categorized');
    }
    if (row.category_id !== null) {
      throw new HttpError(409, 'transaction already has a category', 'categorize_already_categorized');
    }
    if (!(await stillNeedsCategory(client, budgetId, item.transaction_id, pending))) {
      throw new HttpError(409, 'transaction no longer needs a category', 'categorize_not_needing_category');
    }
    if (staleAccept) {
      // The queue shows this row again: put its earlier suggestions back, so
      // accept and the decision write start from the state a first accept
      // expects.
      await restorePendingSuggestions(client, budgetId, item.transaction_id);
    } else {
      // Any other decided suggestion freezes it. Undo's "previous status" is
      // therefore pending.
      const decided = await client.query(
        `select 1 from public.category_suggestions
          where transaction_id = $1 and budget_id = $2 and status <> 'pending' limit 1`,
        [item.transaction_id, budgetId],
      );
      if ((decided.rowCount ?? 0) > 0) {
        throw new HttpError(409, 'transaction already has a decision', 'categorize_already_categorized');
      }
    }
    await updateTransactionInClient(client, {
      budgetId,
      id: item.transaction_id,
      patch: { category_id: item.category_id },
      subtransactions: undefined,
    });
    await client.query(
      `insert into public.categorize_decisions (transaction_id, budget_id, kind, category_id, user_id)
       values ($1, $2, 'accept', $3, $4)
       on conflict (transaction_id) do update
         set kind = 'accept', category_id = excluded.category_id,
             user_id = excluded.user_id, created_at = now()`,
      [item.transaction_id, budgetId, item.category_id, userId],
    );
    await settleSuggestions(client, budgetId, item.transaction_id, item.category_id);
    accepted += 1;
  }

  return { accepted, items: [...items] };
}

/** Categorize a batch of explicit pairs atomically. */
export async function acceptCategories(
  pool: Pool,
  budgetId: string,
  items: readonly DecisionItem[],
  userId: string | null,
): Promise<{ accepted: number; items: DecisionItem[] }> {
  return withTransaction(pool, async (client) => {
    const pending = await pendingTransferIds(client, budgetId);
    return acceptItems(client, budgetId, items, userId, pending);
  });
}

/**
 * Accept every row of one bundle. The bundle's current rows and top category
 * are re-resolved inside this transaction (one transfer-plan computation for
 * the whole request). Above 1000 rows nothing is applied: the caller must page
 * the queue's bundle filter and send explicit chunks.
 */
export async function acceptBundle(
  pool: Pool,
  budgetId: string,
  key: BundleKey,
  expectedCount: number,
  userId: string | null,
): Promise<{ accepted: number; items: DecisionItem[] }> {
  return withTransaction(pool, async (client) => {
    const pending = await pendingTransferIds(client, budgetId);
    const transactionIds = await bundleTransactionIds(client, budgetId, key, pending);
    if (transactionIds.length !== expectedCount) {
      throw new HttpError(
        409,
        `bundle changed from ${expectedCount} to ${transactionIds.length} transactions`,
        'categorize_bundle_changed',
        { expected: expectedCount, actual: transactionIds.length },
      );
    }
    if (transactionIds.length > 1000) {
      throw new HttpError(400, 'bundle is above the 1000 transaction cap', 'categorize_bundle_too_large');
    }
    const items = transactionIds.map((transactionId) => ({
      transaction_id: transactionId,
      category_id: key.category_id,
    }));
    return acceptItems(client, budgetId, items, userId, pending);
  });
}

/**
 * Reverse only what accept recorded. Undo trusts no client-supplied category:
 * it reads the decision row accept wrote, and reverts only while the
 * transaction still carries that category, is not an upcoming occurrence and
 * the decision is an accept (a skip record is never touched). Everything else
 * is left untouched and reported in `skipped` with a reason. The whole batch
 * is one transaction; rows are locked transactions-first, decisions-second,
 * both in id order.
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
    const pending = await pendingTransferIds(client, budgetId);
    const locked = await lockLiveTransactions(client, budgetId, transactionIds);
    const decisions = await lockDecisions(client, budgetId, transactionIds);
    const restored: string[] = [];
    const skipped: { transaction_id: string; reason: UndoSkipReason }[] = [];
    for (const transactionId of transactionIds) {
      const row = locked.get(transactionId);
      if (!row) {
        await client.query(
          `delete from public.categorize_decisions where transaction_id = $1 and budget_id = $2`,
          [transactionId, budgetId],
        );
        skipped.push({ transaction_id: transactionId, reason: 'not_found' });
        continue;
      }
      const decided = decisions.get(transactionId);
      if (!decided) {
        skipped.push({ transaction_id: transactionId, reason: 'no_decision' });
        continue;
      }
      if (decided.kind !== 'accept' || decided.category_id === null) {
        skipped.push({ transaction_id: transactionId, reason: 'skipped' });
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
      // The row must still need a category apart from the one accept set: an
      // inflow, transfer or split since accept is not ours to clear.
      if (!(await stillNeedsCategory(client, budgetId, transactionId, pending, true))) {
        skipped.push({ transaction_id: transactionId, reason: 'category_changed' });
        continue;
      }
      await updateTransactionInClient(client, {
        budgetId,
        id: transactionId,
        patch: { category_id: null },
        subtransactions: undefined,
      });
      await restorePendingSuggestions(client, budgetId, transactionId);
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
 * Skip a transaction in the queue whatever its state: dismiss its suggestions
 * and record a skip decision (which also hides it from the queue). Repeating is
 * a no-op. A stale accept (accepted, then the category was cleared by hand) is
 * replaced; a transaction that already carries a category is a 409.
 */
export async function skipTransaction(
  pool: Pool,
  budgetId: string,
  transactionId: string,
  userId: string | null,
): Promise<{ dismissed: number }> {
  return withTransaction(pool, async (client) => {
    const row = await lockLiveTransaction(client, budgetId, transactionId);
    if (row.category_id !== null) {
      throw new HttpError(409, 'transaction already has a category', 'categorize_already_categorized');
    }
    const decision = await client.query<DecisionRow>(
      `select kind, category_id from public.categorize_decisions
        where transaction_id = $1 and budget_id = $2
        for update`,
      [transactionId, budgetId],
    );
    const current = decision.rows[0];
    if (current?.kind === 'skip') return { dismissed: 0 };
    // A stale accept's rows are accepted/dismissed, not pending: dismiss them
    // all so a later read has nothing to revive.
    const dismissed = await client.query(
      `update public.category_suggestions
          set status = 'dismissed', updated_at = now()
        where transaction_id = $1 and budget_id = $2 and status <> 'dismissed'`,
      [transactionId, budgetId],
    );
    if (current) {
      await client.query(
        `update public.categorize_decisions
            set kind = 'skip', category_id = null, user_id = $3, created_at = now()
          where transaction_id = $1 and budget_id = $2`,
        [transactionId, budgetId, userId],
      );
    } else {
      await client.query(
        `insert into public.categorize_decisions (transaction_id, budget_id, kind, category_id, user_id)
         values ($1, $2, 'skip', null, $3)`,
        [transactionId, budgetId, userId],
      );
    }
    return { dismissed: dismissed.rowCount ?? 0 };
  });
}
