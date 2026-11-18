/**
 * Budget store: category groups. SQL only (moved verbatim from
 * routes/groups.ts); every function takes a Queryable.
 */
import type { Queryable } from '../../core/db';

export async function listGroups(db: Queryable, budgetId: string) {
  const result = await db.query('SELECT * FROM category_groups WHERE budget_id = $1 AND deleted = false ORDER BY sort_order', [budgetId]);
  return result.rows;
}

/** Insert a group sorted after the last existing one. */
export async function insertGroupLast(db: Queryable, budgetId: string, name: string) {
  const result = await db.query(
    `INSERT INTO category_groups (budget_id, name, sort_order)
       VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) + 1 FROM category_groups WHERE budget_id = $1), 0))
       RETURNING *`,
    [budgetId, name],
  );
  return result.rows[0];
}

/** Rename a live group of the budget; false when none matched. */
export async function renameGroup(db: Queryable, id: string, budgetId: string, name: string): Promise<boolean> {
  const result = await db.query('UPDATE category_groups SET name = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false', [
    name,
    id,
    budgetId,
  ]);
  return result.rowCount !== 0;
}

/** Tombstone a live group of the budget; false when none matched. */
export async function tombstoneGroup(db: Queryable, id: string, budgetId: string): Promise<boolean> {
  const result = await db.query('UPDATE category_groups SET deleted = true WHERE id = $1 AND budget_id = $2 AND deleted = false', [
    id,
    budgetId,
  ]);
  return result.rowCount !== 0;
}

/** Tombstone the live categories of a group. */
export async function tombstoneGroupCategories(db: Queryable, groupId: string, budgetId: string): Promise<void> {
  await db.query('UPDATE categories SET deleted = true WHERE group_id = $1 AND budget_id = $2 AND deleted = false', [groupId, budgetId]);
}
