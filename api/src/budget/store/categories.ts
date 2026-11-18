/**
 * Budget store: categories. SQL only; every function takes a Queryable.
 */
import type { Queryable } from '../../core/db';

/** Does the category exist in this budget (any state)? */
export async function categoryInBudget(db: Queryable, categoryId: string, budgetId: string): Promise<boolean> {
  const catCheck = await db.query('SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2', [categoryId, budgetId]);
  return catCheck.rowCount !== 0;
}
