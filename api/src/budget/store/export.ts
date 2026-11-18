/**
 * Budget store: full-budget export reads. SQL only (moved verbatim from
 * routes/budget-export.ts); every function takes a Queryable and the budget id.
 */
import type { Queryable } from '../../core/db';

export interface Row {
  [column: string]: unknown;
}

const q = async (db: Queryable, sql: string, budgetId: string): Promise<Row[]> => (await db.query<Row>(sql, [budgetId])).rows;

export const exportBudgetRow = async (db: Queryable, budgetId: string): Promise<Row | undefined> =>
  (await q(db, 'SELECT name, archived_at FROM budgets WHERE id = $1', budgetId))[0];

export const exportGroups = (db: Queryable, budgetId: string) =>
  q(db, 'SELECT id, name FROM category_groups WHERE budget_id = $1 AND NOT deleted ORDER BY sort_order, name, id', budgetId);

export const exportCategories = (db: Queryable, budgetId: string) =>
  q(
    db,
    `SELECT c.id, c.group_id, c.name, c.hidden, c.user_id, c.bundle_id FROM categories c
         JOIN category_groups g ON g.id = c.group_id AND NOT g.deleted
         WHERE c.budget_id = $1 AND NOT c.deleted
         ORDER BY g.sort_order, g.name, g.id, c.sort_order, c.name, c.id`,
    budgetId,
  );

export const exportBundles = (db: Queryable, budgetId: string) =>
  q(
    db,
    `SELECT b.id, b.group_id, b.name FROM category_bundles b
         WHERE b.budget_id = $1 ORDER BY b.created_at, b.name, b.id`,
    budgetId,
  );

export const exportAccounts = (db: Queryable, budgetId: string) =>
  q(db, 'SELECT id, name, user_id, currency FROM accounts WHERE budget_id = $1 AND NOT deleted ORDER BY sort_order, name, id', budgetId);

export const exportTransactions = (db: Queryable, budgetId: string) =>
  q(
    db,
    `SELECT t.id, t.account_id, t.date::text AS date, t.amount, t.memo, t.cleared::text AS cleared,
              t.category_id, t.transfer_transaction_id, t.flag_color, t.flag_name, p.name AS payee
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
       WHERE t.budget_id = $1 AND NOT t.deleted AND NOT t.upcoming
       ORDER BY t.date, t.amount, t.memo, t.id`,
    budgetId,
  );

export const exportSplits = (db: Queryable, budgetId: string) =>
  q(
    db,
    `SELECT s.transaction_id, s.amount, s.memo, s.category_id FROM subtransactions s
       WHERE s.budget_id = $1 AND NOT s.deleted ORDER BY s.created_at, s.amount, s.memo, s.id`,
    budgetId,
  );

export const exportAssignments = (db: Queryable, budgetId: string) =>
  q(
    db,
    `SELECT category_id, month::text AS month, budgeted FROM assignments
         WHERE budget_id = $1 ORDER BY month, category_id`,
    budgetId,
  );

export const exportPayees = (db: Queryable, budgetId: string) =>
  q(db, 'SELECT name FROM payees WHERE budget_id = $1 AND NOT deleted AND transfer_account_id IS NULL ORDER BY name', budgetId);

export const exportTargets = (db: Queryable, budgetId: string) =>
  q(db, 'SELECT category_id, kind, amount_cents, config FROM category_targets WHERE budget_id = $1', budgetId);

export const exportCategoryNotes = (db: Queryable, budgetId: string) =>
  q(db, "SELECT category_id, month::text AS month, note FROM category_notes WHERE budget_id = $1 ORDER BY month", budgetId);

export const exportMonthNotes = (db: Queryable, budgetId: string) =>
  q(db, 'SELECT month::text AS month, note FROM month_notes WHERE budget_id = $1 AND NOT deleted ORDER BY month', budgetId);

export const exportRepeatRules = (db: Queryable, budgetId: string) =>
  q(
    db,
    `SELECT r.account_id, r.category_id, r.memo, r.amount, r.frequency, r.next_due_date::text AS next_due_date,
              r.month_last_day, p.name AS payee
       FROM txn_repeat_rules r LEFT JOIN payees p ON p.id = r.payee_id
       WHERE r.budget_id = $1 AND NOT r.deleted ORDER BY r.created_at, r.id`,
    budgetId,
  );
