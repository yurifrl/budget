/** Shared bundle invariants (docs/category-bundles-design.md). */
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

/**
 * Restore the bundle invariants after categories moved/deleted: a category
 * whose bundle lives in another group leaves the bundle, and a bundle with no
 * live categories is deleted.
 */
export async function normalizeBundles(db: Queryable, budgetId: string): Promise<void> {
  await db.query(
    `UPDATE categories c SET bundle_id = NULL
     FROM category_bundles b
     WHERE c.bundle_id = b.id AND c.budget_id = $1 AND (b.group_id <> c.group_id OR c.deleted)`,
    [budgetId],
  );
  await db.query(
    `DELETE FROM category_bundles b WHERE b.budget_id = $1
     AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.bundle_id = b.id AND NOT c.deleted)`,
    [budgetId],
  );
}
