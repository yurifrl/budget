/**
 * Budget store: category targets. SQL only (moved verbatim from
 * routes/category-targets.ts); every function takes a Queryable.
 */
import type { Queryable } from '../../core/db';

export async function listTargets(db: Queryable, budgetId: string) {
  const result = await db.query('SELECT * FROM category_targets WHERE budget_id = $1 ORDER BY category_id', [budgetId]);
  return result.rows;
}

export async function upsertTarget(
  db: Queryable,
  t: { budgetId: string; categoryId: string; kind: string; amountCents: number; snoozeMonth: string | null; configJson: string },
) {
  const result = await db.query(
    `INSERT INTO category_targets (budget_id, category_id, kind, amount_cents, snooze_month, config)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category_id) DO UPDATE
         SET kind = EXCLUDED.kind,
             amount_cents = EXCLUDED.amount_cents,
             snooze_month = EXCLUDED.snooze_month,
             config = EXCLUDED.config,
             updated_at = now()
       RETURNING *`,
    [t.budgetId, t.categoryId, t.kind, t.amountCents, t.snoozeMonth, t.configJson],
  );
  return result.rows[0];
}

/** Remove a category's target; false when there was none. */
export async function deleteTarget(db: Queryable, categoryId: string, budgetId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM category_targets WHERE category_id = $1 AND budget_id = $2', [categoryId, budgetId]);
  return result.rowCount !== 0;
}
