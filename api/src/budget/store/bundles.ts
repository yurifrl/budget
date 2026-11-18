/**
 * Budget store: category bundles (and the category columns they own). SQL
 * only (moved verbatim from routes/category-bundles.ts); every function takes
 * a Queryable.
 */
import type { Queryable } from '../../core/db';

export async function listBundles(db: Queryable, budgetId: string) {
  const result = await db.query('SELECT * FROM category_bundles WHERE budget_id = $1 ORDER BY created_at, id', [budgetId]);
  return result.rows;
}

/** Live categories of the budget among `ids` with their group. */
export async function findLiveCategories(db: Queryable, ids: string[], budgetId: string) {
  const found = await db.query<{ id: string; group_id: string }>(
    'SELECT id, group_id FROM categories WHERE id = ANY($1::uuid[]) AND budget_id = $2 AND deleted = false',
    [ids, budgetId],
  );
  return found.rows;
}

/** Next free sort_order at the end of a group. */
export async function nextSortOrderInGroup(db: Queryable, groupId: string, budgetId: string): Promise<number> {
  return Number(
    (
      await db.query<{ n: number }>(
        'SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM categories WHERE group_id = $1 AND budget_id = $2 AND deleted = false',
        [groupId, budgetId],
      )
    ).rows[0].n,
  );
}

/** Put a category in a bundle (and group); `sortOrder` only when it moves groups. */
export async function setCategoryBundle(
  db: Queryable,
  c: { bundleId: string; groupId: string; id: string; budgetId: string; sortOrder?: number },
): Promise<void> {
  const moving = c.sortOrder !== undefined;
  await db.query(
    `UPDATE categories SET bundle_id = $1, group_id = $2${moving ? ', sort_order = $5' : ''} WHERE id = $3 AND budget_id = $4`,
    moving ? [c.bundleId, c.groupId, c.id, c.budgetId, c.sortOrder] : [c.bundleId, c.groupId, c.id, c.budgetId],
  );
}

/** Does the live group exist in this budget? */
export async function liveGroupInBudget(db: Queryable, groupId: string, budgetId: string): Promise<boolean> {
  const group = await db.query('SELECT 1 FROM category_groups WHERE id = $1 AND budget_id = $2 AND deleted = false', [
    groupId,
    budgetId,
  ]);
  return group.rowCount !== 0;
}

export async function insertBundle(db: Queryable, budgetId: string, groupId: string, name: string) {
  const created = await db.query('INSERT INTO category_bundles (budget_id, group_id, name) VALUES ($1, $2, $3) RETURNING *', [
    budgetId,
    groupId,
    name,
  ]);
  return created.rows[0];
}

export async function renameBundle(db: Queryable, id: string, budgetId: string, name: string): Promise<boolean> {
  const result = await db.query('UPDATE category_bundles SET name = $1 WHERE id = $2 AND budget_id = $3', [name, id, budgetId]);
  return result.rowCount !== 0;
}

export async function clearBundleFromCategories(db: Queryable, bundleId: string, budgetId: string): Promise<void> {
  await db.query('UPDATE categories SET bundle_id = NULL WHERE bundle_id = $1 AND budget_id = $2', [bundleId, budgetId]);
}

export async function deleteBundle(db: Queryable, id: string, budgetId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM category_bundles WHERE id = $1 AND budget_id = $2', [id, budgetId]);
  return result.rowCount !== 0;
}

/** Take live categories out of any bundle; returns rows updated. */
export async function unbundleCategories(db: Queryable, ids: string[], budgetId: string): Promise<number> {
  const result = await db.query(
    'UPDATE categories SET bundle_id = NULL WHERE id = ANY($1::uuid[]) AND budget_id = $2 AND deleted = false',
    [ids, budgetId],
  );
  return result.rowCount ?? 0;
}

export async function getBundleGroup(db: Queryable, bundleId: string, budgetId: string): Promise<string | undefined> {
  const bundle = await db.query<{ group_id: string }>('SELECT group_id FROM category_bundles WHERE id = $1 AND budget_id = $2', [
    bundleId,
    budgetId,
  ]);
  return bundle.rows[0]?.group_id;
}
