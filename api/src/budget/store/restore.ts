/**
 * Budget store: full-budget restore writes. SQL only (moved verbatim from
 * routes/budget-restore.ts); every function takes a Queryable (the restore
 * transaction's client).
 */
import type { Queryable } from '../../core/db';

/** Tables wiped before the payload is re-created. Child-first order. */
export const WIPE_TABLES = [
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

export async function budgetExists(db: Queryable, budgetId: string): Promise<boolean> {
  const budget = await db.query('SELECT 1 FROM budgets WHERE id = $1', [budgetId]);
  return budget.rowCount !== 0;
}

/** Delete every row of the budget-scoped data tables, child first. */
export async function wipeBudgetData(db: Queryable, budgetId: string): Promise<void> {
  for (const table of WIPE_TABLES) {
    await db.query(`DELETE FROM public.${table} WHERE budget_id = $1`, [budgetId]);
  }
}

export async function insertRestoredGroup(db: Queryable, id: string, budgetId: string, name: string, sortOrder: number): Promise<void> {
  await db.query(
    `INSERT INTO public.category_groups (id, budget_id, name, sort_order)
         VALUES ($1, $2, $3, $4)`,
    [id, budgetId, name, sortOrder],
  );
}

export async function insertRestoredBundle(db: Queryable, id: string, budgetId: string, groupId: string, name: string): Promise<void> {
  await db.query('INSERT INTO public.category_bundles (id, budget_id, group_id, name) VALUES ($1, $2, $3, $4)', [
    id,
    budgetId,
    groupId,
    name,
  ]);
}

export async function insertRestoredCategory(
  db: Queryable,
  c: {
    id: string;
    budgetId: string;
    groupId: string;
    name: string;
    sortOrder: number;
    hidden: boolean;
    userId: string | null;
    bundleId: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO public.categories (id, budget_id, group_id, name, sort_order, hidden, user_id, bundle_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [c.id, c.budgetId, c.groupId, c.name, c.sortOrder, c.hidden, c.userId, c.bundleId],
  );
}

export async function insertRestoredAccount(
  db: Queryable,
  id: string,
  budgetId: string,
  name: string,
  userId: string | null,
  currency: string | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO public.accounts (id, budget_id, name, type, account_group, user_id, currency)
         VALUES ($1, $2, $3, 'checking', 'CASH', $4, $5)`,
    [id, budgetId, name, userId, currency],
  );
}

/** Resolve-or-create a payee by (budget, name); returns its id. */
export async function upsertRestoredPayee(db: Queryable, id: string, budgetId: string, name: string): Promise<string> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO public.payees (id, budget_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (budget_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
    [id, budgetId, name],
  );
  return inserted.rows[0].id;
}

export async function insertRestoredTransaction(
  db: Queryable,
  t: {
    id: string;
    budgetId: string;
    accountId: string;
    date: string;
    amount: number;
    payeeId: string | null;
    categoryId: string | null;
    memo: string;
    cleared: string;
    flagColor: string | null;
    flagName: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO public.transactions
          (id, budget_id, account_id, date, amount, payee_id, category_id, memo,
           cleared, approved, flag_color, flag_name, repeat, deleted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, 'never', false)`,
    [t.id, t.budgetId, t.accountId, t.date, t.amount, t.payeeId, t.categoryId, t.memo, t.cleared, t.flagColor, t.flagName],
  );
}

export async function linkRestoredTransferPeer(db: Queryable, transactionId: string, peerId: string): Promise<void> {
  await db.query('UPDATE public.transactions SET transfer_transaction_id = $1 WHERE id = $2', [peerId, transactionId]);
}

/** Point "Transfer : <account>" payees at their account. */
export async function linkRestoredTransferPayees(db: Queryable, budgetId: string): Promise<void> {
  await db.query(
    `UPDATE public.payees p SET transfer_account_id = a.id
       FROM public.accounts a
       WHERE p.budget_id = $1 AND p.name = 'Transfer : ' || a.name`,
    [budgetId],
  );
}

export async function insertRestoredAssignment(
  db: Queryable,
  id: string,
  budgetId: string,
  month: string,
  categoryId: string,
  budgeted: number,
): Promise<void> {
  await db.query(
    `INSERT INTO public.assignments (id, budget_id, month, category_id, budgeted)
         VALUES ($1, $2, $3, $4, $5)`,
    [id, budgetId, month, categoryId, budgeted],
  );
}
