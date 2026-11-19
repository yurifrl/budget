/**
 * Budget store: full-budget restore writes. SQL only (moved verbatim from
 * routes/budget-restore.ts); every function takes a Queryable (the restore
 * transaction's client).
 */
import type { Queryable } from '../../core/db';

/** Register tables wiped by a register (or full) restore. Child-first order. */
export const REGISTER_WIPE_TABLES = [
  'subtransactions',
  'transactions',
  'txn_repeat_rules',
  'scheduled_subtransactions',
  'scheduled_transactions',
  'accounts',
  'payee_locations',
  'payees',
] as const;

/** Plan tables wiped by a plan (or full) restore. Child-first order. */
export const PLAN_WIPE_TABLES = [
  'assignments',
  'category_targets',
  'category_notes',
  'month_notes',
  'categories',
  'category_bundles',
  'category_groups',
] as const;

/** Full-restore wipe order (kept: register rows reference categories, so they go first). */
export const WIPE_TABLES = [
  'subtransactions',
  'transactions',
  'txn_repeat_rules',
  'scheduled_subtransactions',
  'scheduled_transactions',
  ...PLAN_WIPE_TABLES,
  'accounts',
  'payee_locations',
  'payees',
] as const;

/** Tables whose category_id / default_category_id points into the plan. */
const CATEGORY_LINK_TABLES: ReadonlyArray<readonly [table: string, column: string]> = [
  ['transactions', 'category_id'],
  ['subtransactions', 'category_id'],
  ['scheduled_transactions', 'category_id'],
  ['scheduled_subtransactions', 'category_id'],
  ['txn_repeat_rules', 'category_id'],
  ['payees', 'default_category_id'],
];

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

/** Delete the plan tables only (register rows keep living; their category links go NULL). */
export async function wipePlanData(db: Queryable, budgetId: string): Promise<void> {
  for (const table of PLAN_WIPE_TABLES) {
    await db.query(`DELETE FROM public.${table} WHERE budget_id = $1`, [budgetId]);
  }
}

/** Delete the register tables only. */
export async function wipeRegisterData(db: Queryable, budgetId: string): Promise<void> {
  for (const table of REGISTER_WIPE_TABLES) {
    await db.query(`DELETE FROM public.${table} WHERE budget_id = $1`, [budgetId]);
  }
}

/** A category of the budget with its group name (for matching by group+name). */
export interface CategoryKeyRow {
  id: string;
  group_name: string;
  name: string;
}

export async function listCategoryKeys(db: Queryable, budgetId: string): Promise<CategoryKeyRow[]> {
  const res = await db.query<CategoryKeyRow>(
    `SELECT c.id, g.name AS group_name, c.name
       FROM public.categories c JOIN public.category_groups g ON g.id = c.group_id
       WHERE c.budget_id = $1
       ORDER BY g.sort_order, c.sort_order`,
    [budgetId],
  );
  return res.rows;
}

/**
 * Remember which category (by group+name) every register row points at, before a
 * plan wipe sets those links NULL. Lives in a temp table until the transaction ends.
 */
export async function snapshotCategoryLinks(db: Queryable, budgetId: string): Promise<void> {
  await db.query('DROP TABLE IF EXISTS restore_category_links');
  await db.query(
    `CREATE TEMP TABLE restore_category_links (tbl text, col text, row_id uuid, grp text, name text) ON COMMIT DROP`,
  );
  for (const [table, column] of CATEGORY_LINK_TABLES) {
    await db.query(
      `INSERT INTO restore_category_links (tbl, col, row_id, grp, name)
         SELECT $2, $3, t.id, lower(g.name), lower(c.name)
         FROM public.${table} t
         JOIN public.categories c ON c.id = t.${column}
         JOIN public.category_groups g ON g.id = c.group_id
         WHERE t.budget_id = $1`,
      [budgetId, table, column],
    );
  }
}

/** Re-point the snapshotted links at the freshly restored categories (matching group+name). */
export async function relinkCategoryLinks(db: Queryable, budgetId: string): Promise<void> {
  for (const [table, column] of CATEGORY_LINK_TABLES) {
    await db.query(
      `UPDATE public.${table} t SET ${column} = m.id
         FROM (
           SELECT DISTINCT ON (l.row_id) l.row_id, c.id
           FROM restore_category_links l
           JOIN public.category_groups g ON g.budget_id = $1 AND lower(g.name) = l.grp
           JOIN public.categories c ON c.group_id = g.id AND lower(c.name) = l.name
           WHERE l.tbl = $2 AND l.col = $3
           ORDER BY l.row_id, g.sort_order, c.sort_order
         ) m
         WHERE t.id = m.row_id`,
      [budgetId, table, column],
    );
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

/**
 * Point "Transfer : <account>" payees at their account. Both sides are scoped to
 * the budget: accounts of other budgets may share a name (budget-njc).
 */
export async function linkRestoredTransferPayees(db: Queryable, budgetId: string): Promise<void> {
  await db.query(
    `UPDATE public.payees p SET transfer_account_id = a.id
       FROM public.accounts a
       WHERE p.budget_id = $1 AND a.budget_id = $1 AND NOT a.deleted
         AND p.name = 'Transfer : ' || a.name`,
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
