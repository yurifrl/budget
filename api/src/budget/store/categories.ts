/**
 * Budget store: categories. SQL only; every function takes a Queryable.
 */
import type { Queryable } from '../../core/db';

/** Does the category exist in this budget (any state)? */
export async function categoryInBudget(db: Queryable, categoryId: string, budgetId: string): Promise<boolean> {
  const catCheck = await db.query('SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2', [categoryId, budgetId]);
  return catCheck.rowCount !== 0;
}

export async function listLiveCategories(db: Queryable, budgetId: string) {
  const result = await db.query('SELECT * FROM categories WHERE budget_id = $1 AND deleted = false ORDER BY sort_order', [budgetId]);
  return result.rows;
}

/** Does the category group exist in this budget (any state)? */
export async function groupInBudget(db: Queryable, groupId: string, budgetId: string): Promise<boolean> {
  const groupCheck = await db.query('SELECT 1 FROM category_groups WHERE id = $1 AND budget_id = $2', [groupId, budgetId]);
  return groupCheck.rowCount !== 0;
}

export async function insertCategory(
  db: Queryable,
  c: { budgetId: string; groupId: string; name: string; sortOrder: number; userId: string | null },
) {
  const result = await db.query(
    'INSERT INTO categories (budget_id, group_id, name, sort_order, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [c.budgetId, c.groupId, c.name, c.sortOrder, c.userId],
  );
  return result.rows[0];
}

export async function setCategoryPerson(db: Queryable, id: string, budgetId: string, userId: string | null): Promise<boolean> {
  const result = await db.query('UPDATE categories SET user_id = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false', [
    userId,
    id,
    budgetId,
  ]);
  return result.rowCount !== 0;
}

export async function setCategoryNote(db: Queryable, id: string, budgetId: string, note: string | null): Promise<boolean> {
  const result = await db.query('UPDATE categories SET note = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false', [
    note,
    id,
    budgetId,
  ]);
  return result.rowCount !== 0;
}

export async function renameCategory(db: Queryable, id: string, budgetId: string, name: string): Promise<boolean> {
  const result = await db.query('UPDATE categories SET name = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false', [
    name,
    id,
    budgetId,
  ]);
  return result.rowCount !== 0;
}

export async function setCategoryHidden(db: Queryable, id: string, budgetId: string, hidden: boolean): Promise<boolean> {
  const result = await db.query('UPDATE categories SET hidden = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false', [
    hidden,
    id,
    budgetId,
  ]);
  return result.rowCount !== 0;
}

/** Assign every live category of a group to `userId` (null = Shared). */
export async function setGroupCategoriesPerson(db: Queryable, groupId: string, budgetId: string, userId: string | null): Promise<void> {
  await db.query('UPDATE categories SET user_id = $1 WHERE group_id = $2 AND budget_id = $3 AND deleted = false', [
    userId,
    groupId,
    budgetId,
  ]);
}

export interface GoalColumns {
  goal_type: string | null;
  goal_target: number | null;
  goal_cadence: number | null;
  goal_cadence_frequency: number | null;
  goal_target_date: string | null;
  goal_needs_whole_amount: boolean | null;
}

export async function setCategoryGoal(db: Queryable, id: string, budgetId: string, cols: GoalColumns): Promise<boolean> {
  const result = await db.query(
    `UPDATE categories SET
        goal_type = $1,
        goal_target = $2,
        goal_cadence = $3,
        goal_cadence_frequency = $4,
        goal_target_date = $5,
        goal_needs_whole_amount = $6
       WHERE id = $7 AND budget_id = $8 AND deleted = false`,
    [
      cols.goal_type,
      cols.goal_target,
      cols.goal_cadence,
      cols.goal_cadence_frequency,
      cols.goal_target_date,
      cols.goal_needs_whole_amount,
      id,
      budgetId,
    ],
  );
  return result.rowCount !== 0;
}

/** Move one live category of the budget; returns rows updated (0 or 1). */
export async function moveCategory(db: Queryable, budgetId: string, move: { id: string; group_id: string; sort_order: number }): Promise<number> {
  const result = await db.query(
    'UPDATE categories SET group_id = $1, sort_order = $2 WHERE id = $3 AND budget_id = $4 AND deleted = false',
    [move.group_id, move.sort_order, move.id, budgetId],
  );
  return result.rowCount ?? 0;
}

export async function softDeleteCategory(db: Queryable, id: string, budgetId: string): Promise<boolean> {
  const result = await db.query('UPDATE categories SET deleted = true WHERE id = $1 AND budget_id = $2 AND deleted = false', [
    id,
    budgetId,
  ]);
  return result.rowCount !== 0;
}
