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

import {
  categoryAssignability,
  freeTransferCounterpart,
  linkByUser,
  setTransferMarks,
  transferMarksOf,
  unlinkTransfers,
  updateTransactionInClient,
} from '../budget';
import { withTransaction, type Queryable } from '../core/db';
import { HttpError } from '../core/validate';
import { bundleTransactionIds, type BundleKey } from './queue-store';
import {
  DECISION_IN_EFFECT_COLUMN,
  NEEDS_CATEGORY_FROM,
  NEEDS_CATEGORY_WHERE,
  NEEDS_CATEGORY_WHERE_IGNORING_CATEGORY,
  pendingTransferIds,
  REFUSED,
  restorePendingSuggestions,
  TRANSFER_OPEN_FOR_ROW,
  type SuggestionTarget,
} from './store';
import { TRANSFER_WINDOW_DAYS } from './run-store';

/**
 * One target of a decision: the category a row was filed under, or the account
 * the money moved to or came from. The contract allows exactly one of the two;
 * {@link decisionTarget} is the single place that reads which one it is.
 */
export type DecisionItem = {
  transaction_id: string;
  category_id?: string | null;
  transfer_account_id?: string | null;
};
export type UndoSkipReason = 'no_decision' | 'category_changed' | 'upcoming' | 'skipped' | 'not_found';

type LockedTransaction = {
  category_id: string | null;
  upcoming: boolean;
  transfer_account_id: string | null;
  /** Signed integer milliunits; an outflow is negative. */
  amount: number;
  /** YYYY-MM-DD. */
  date: string;
};
type DecisionRow = {
  kind: string;
  category_id: string | null;
  transfer_account_id: string | null;
  /** The marks a transfer accept replaced, by transaction id (null = none). */
  prev_marks: Record<string, string | null> | null;
  /** The person's standing decision about the row (store.ts `DECISION_IN_EFFECT`); false = stale. */
  in_effect: boolean;
};

/**
 * The one target a decision names. The contract already refuses both-or-neither
 * at the HTTP edge; this is the store's own guard for internal callers.
 */
function decisionTarget(item: DecisionItem): SuggestionTarget {
  if (item.category_id) return { kind: 'category', categoryId: item.category_id };
  if (item.transfer_account_id) return { kind: 'transfer', accountId: item.transfer_account_id };
  throw new HttpError(400, 'a decision names a category or a transfer account', 'invalid_input');
}

/** The id a stored decision already names, for the idempotency test. */
const decidedId = (decision: DecisionRow): string | null =>
  decision.kind === 'transfer' ? decision.transfer_account_id : decision.category_id;

/** One scoped lock of a live transaction; 404 says nothing about whose budget it is. */
async function lockLiveTransaction(
  client: Queryable,
  budgetId: string,
  transactionId: string,
): Promise<{ category_id: string | null; payee_id: string | null; account_id: string }> {
  const { rows } = await client.query<{ category_id: string | null; payee_id: string | null; account_id: string }>(
    `select category_id, payee_id, account_id from public.transactions
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
    `select id, category_id, upcoming, transfer_account_id, amount, date::text as date
       from public.transactions
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
    `select d.transaction_id, d.kind, d.category_id, d.transfer_account_id, d.prev_marks, ${DECISION_IN_EFFECT_COLUMN}
       from public.categorize_decisions d
       join public.transactions t on t.id = d.transaction_id and t.budget_id = d.budget_id
      where d.budget_id = $1 and d.transaction_id = any($2::uuid[])
      order by d.transaction_id
      for update of d`,
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
 * May the row still be answered as a transfer to THIS account? The same rules
 * the Transfers read lists it by (the run's candidate rule, no standing
 * decision, and the per-account `TRANSFER_PAIR_OPEN`), so a suggestion whose
 * other leg was deleted since — or whose row became a transfer by hand, or got
 * a "not a transfer" mark — is refused instead of applied blind. The account's
 * own state is the register link's to check.
 */
async function stillTransferable(
  client: Queryable,
  budgetId: string,
  transactionId: string,
  accountId: string,
  pending: readonly string[],
): Promise<boolean> {
  const { rowCount } = await client.query(
    `select 1 ${NEEDS_CATEGORY_FROM} ${TRANSFER_OPEN_FOR_ROW}`,
    [budgetId, pending, transactionId, TRANSFER_WINDOW_DAYS, accountId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Mark the person's choice: the pending suggestion of that target becomes
 * accepted and every other pending suggestion is dismissed. When the chosen
 * target was not among the suggestions, rank 1 is overwritten with a `manual`
 * accepted row.
 */
async function settleSuggestions(
  client: Queryable,
  budgetId: string,
  transactionId: string,
  target: SuggestionTarget,
): Promise<void> {
  const chosen = target.kind === 'category' ? target.categoryId : target.accountId;
  // A constant of the branch, never caller text: the column names come from the
  // two shapes of a target and nothing else.
  const column = target.kind === 'category' ? 'category_id' : 'transfer_account_id';
  const matched = await client.query(
    `update public.category_suggestions
        set status = 'accepted', updated_at = now()
      where transaction_id = $1 and budget_id = $2 and status = 'pending' and ${column} = $3`,
    [transactionId, budgetId, chosen],
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
       (transaction_id, budget_id, rank, category_id, transfer_account_id, confidence, reason, source, provider, model, status)
     values ($1, $2, 1, $3, $4, 1, null, 'manual', null, null, 'accepted')
     on conflict (transaction_id, rank) do update
       set category_id = excluded.category_id, transfer_account_id = excluded.transfer_account_id,
           confidence = 1, reason = null, source = 'manual', provider = null, model = null,
           status = 'accepted', updated_at = now()`,
    [
      transactionId,
      budgetId,
      target.kind === 'category' ? chosen : null,
      target.kind === 'transfer' ? chosen : null,
    ],
  );
}

/**
 * Apply explicit targets inside the caller's transaction. Locks every
 * transaction first, then every decision row, both in id order. Returns the
 * targets (unchanged) for the client's undo; `accepted` counts only new writes.
 */
async function acceptItems(
  client: PoolClient,
  budgetId: string,
  items: readonly DecisionItem[],
  userId: string | null,
  pending: readonly string[],
): Promise<{ accepted: number; items: DecisionItem[] }> {
  for (const categoryId of new Set(items.map((item) => item.category_id))) {
    if (!categoryId) continue;
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
    const target = decisionTarget(item);
    const wanted = target.kind === 'category' ? target.categoryId : target.accountId;
    const row = locked.get(item.transaction_id);
    if (!row) throw new HttpError(404, 'transaction not found');
    const decision = decisions.get(item.transaction_id);
    // Only a standing decision freezes the row (store.ts `DECISION_IN_EFFECT`).
    // A stale one — its category cleared by hand, its link undone in the
    // register — is no decision any more, and this accept replaces it.
    if (decision?.in_effect) {
      // Idempotent only for a target accept itself applied; another value (or a
      // skip) means a person (or another tab) changed it after this queue was
      // read. A repeat never rewrites the suggestion.
      if (decidedId(decision) === wanted) continue;
      throw new HttpError(409, 'transaction already has a decision', 'categorize_already_categorized');
    }
    if (row.category_id !== null) {
      throw new HttpError(409, 'transaction already has a category', 'categorize_already_categorized');
    }
    // A transfer names an account, and its other leg is looked up FIRST, by the
    // one counterpart rule: when an INFLOW's leg is gone the honest answer is
    // that the pair went away, not that the row stopped needing a category, and
    // no leg may be invented for an inflow (it would record a payment that never
    // happened). An outflow keeps the register's behavior: its leg is created
    // when the account has none.
    let counterpartId: string | null = null;
    if (target.kind === 'transfer') {
      const refused = await client.query(
        `select 1 from public.transactions t where t.id = $1 and t.budget_id = $2 and ${REFUSED}`,
        [item.transaction_id, budgetId],
      );
      if ((refused.rowCount ?? 0) > 0) {
        throw new HttpError(409, 'this row was answered "not a transfer"', 'categorize_transfer_refused');
      }
      counterpartId = await freeTransferCounterpart(client, budgetId, target.accountId, -row.amount, row.date);
      if (row.amount > 0 && counterpartId === null) {
        throw new HttpError(
          409,
          'the other side of this transfer is no longer available',
          'categorize_transfer_pair_gone',
        );
      }
    }
    // The rule the target must still satisfy, before anything is written: a
    // category needs the register's "needs a category", a transfer the same
    // rules the Transfers read lists it by (a row that became a split, a
    // transfer or got a "not a transfer" mark since the list was read).
    const stillOpen =
      target.kind === 'category'
        ? await stillNeedsCategory(client, budgetId, item.transaction_id, pending)
        : await stillTransferable(client, budgetId, item.transaction_id, target.accountId, pending);
    if (!stillOpen) {
      throw new HttpError(409, 'transaction no longer needs a category', 'categorize_not_needing_category');
    }
    // A stale decision's suggestions are shown again: make them pending, so
    // the accept starts from the state a first accept expects (and undo's
    // "previous status" is pending).
    if (decision) await restorePendingSuggestions(client, budgetId, item.transaction_id);
    if (target.kind === 'category') {
      await updateTransactionInClient(client, {
        budgetId,
        id: item.transaction_id,
        patch: { category_id: target.categoryId },
        subtransactions: undefined,
      });
      await client.query(
        `insert into public.categorize_decisions
           (transaction_id, budget_id, kind, category_id, transfer_account_id, user_id)
         values ($1, $2, 'accept', $3, null, $4)
         on conflict (transaction_id) do update
           set kind = 'accept', category_id = excluded.category_id, transfer_account_id = null,
               prev_marks = null, user_id = excluded.user_id, created_at = now()`,
        [item.transaction_id, budgetId, target.categoryId, userId],
      );
    } else {
      // A transfer, through the register's own "link to this account" path, so
      // the account is checked the register's way (not the row's own, open, on
      // budget) with its own codes: the payee becomes the account's system
      // transfer payee, the category is cleared, and the row is paired with the
      // leg looked up above by the same rule (or, for an outflow with none, the
      // leg the register creates). What the marks of both rows were is
      // recorded, so undo can put them back exactly.
      const marks = await transferMarksOf(
        client,
        budgetId,
        counterpartId === null ? [item.transaction_id] : [item.transaction_id, counterpartId],
      );
      await linkByUser(
        client,
        budgetId,
        [{ transaction_id: item.transaction_id, account_id: target.accountId }],
        false,
      );
      await client.query(
        `insert into public.categorize_decisions
           (transaction_id, budget_id, kind, category_id, transfer_account_id, prev_marks, user_id)
         values ($1, $2, 'transfer', null, $3, $4::jsonb, $5)
         on conflict (transaction_id) do update
           set kind = 'transfer', category_id = null,
               transfer_account_id = excluded.transfer_account_id,
               prev_marks = excluded.prev_marks, user_id = excluded.user_id, created_at = now()`,
        [item.transaction_id, budgetId, target.accountId, JSON.stringify(marks), userId],
      );
    }
    await settleSuggestions(client, budgetId, item.transaction_id, target);
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
    const transactionIds = await bundleTransactionIds(client, budgetId, key);
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
    const items = transactionIds.map((transactionId) => ({ transaction_id: transactionId, category_id: key.category_id }));
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
      if (row.upcoming) {
        skipped.push({ transaction_id: transactionId, reason: 'upcoming' });
        continue;
      }
      if (decided.kind === 'transfer') {
        // A transfer accept is reversed by the register's own unlink: both legs
        // get back the payee and category they had, and a leg the link created
        // is deleted again. Only while the row still points at that account: a
        // transfer edited since is not undo's to break.
        const unlinked =
          row.transfer_account_id === decided.transfer_account_id && row.category_id === null
            ? await unlinkTransfers(client, budgetId, [transactionId])
            : 0;
        if (unlinked === 0) {
          skipped.push({ transaction_id: transactionId, reason: 'category_changed' });
          continue;
        }
        // The unlink marks both legs 'manual' so the matcher only suggests
        // them from now on; undo puts back exactly what the accept replaced.
        for (const [id, state] of Object.entries(decided.prev_marks ?? {})) {
          await setTransferMarks(client, budgetId, [id], state as 'dismissed' | 'outside' | 'manual' | null);
        }
        await restorePendingSuggestions(client, budgetId, transactionId);
        await client.query(
          `delete from public.categorize_decisions where transaction_id = $1 and budget_id = $2`,
          [transactionId, budgetId],
        );
        restored.push(transactionId);
        continue;
      }
      if (decided.kind !== 'accept' || decided.category_id === null) {
        skipped.push({ transaction_id: transactionId, reason: 'skipped' });
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
      `select kind, category_id, transfer_account_id, prev_marks
        from public.categorize_decisions
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
            set kind = 'skip', category_id = null, transfer_account_id = null,
                prev_marks = null, user_id = $3, created_at = now()
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

/**
 * "Not a transfer": the person answers that the ROW is not a transfer. The
 * answer is recorded with the account the suggestion named, and from then on no
 * transfer is offered, suggested, listed or accepted for the row (store.ts
 * `REFUSED`); every pending transfer suggestion of the row is dismissed. An
 * outflow keeps its category question — it goes back to the category queue,
 * with whatever category suggestions it has — and an inflow simply leaves. The
 * matcher's own "not a transfer" stays its own action (it marks a known pair).
 * Repeating the same answer is idempotent.
 */
export async function refuseTransfer(
  pool: Pool,
  budgetId: string,
  transactionId: string,
  transferAccountId: string,
  userId: string | null,
): Promise<{ refused: true; dismissed: number }> {
  return withTransaction(pool, async (client) => {
    const row = await lockLiveTransaction(client, budgetId, transactionId);
    if (row.category_id !== null) {
      throw new HttpError(409, 'transaction already has a category', 'categorize_already_categorized');
    }
    const account = await client.query(
      'select 1 from public.accounts where id = $1 and budget_id = $2 and deleted = false',
      [transferAccountId, budgetId],
    );
    if (account.rowCount === 0) throw new HttpError(404, 'account not found');
    if (transferAccountId === row.account_id) {
      throw new HttpError(400, 'cannot transfer to the same account', 'cannot_transfer_to_same_account');
    }

    await client.query(
      `insert into public.categorize_transfer_refusals (transaction_id, budget_id, transfer_account_id, user_id)
       values ($1, $2, $3, $4)
       on conflict (transaction_id, transfer_account_id) do nothing`,
      [transactionId, budgetId, transferAccountId, userId],
    );
    const dismissed = await client.query(
      `update public.category_suggestions
          set status = 'dismissed', updated_at = now()
        where transaction_id = $1 and budget_id = $2
          and category_id is null and transfer_account_id is not null and status = 'pending'`,
      [transactionId, budgetId],
    );
    return { refused: true as const, dismissed: dismissed.rowCount ?? 0 };
  });
}
