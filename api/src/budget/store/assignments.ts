/**
 * Budget store: monthly assignments. SQL only (moved verbatim from
 * routes/assignments.ts and routes/plan-auto-assign.ts); every function takes
 * a Queryable.
 */
import type { Queryable } from '../../core/db';

export async function listAssignments(db: Queryable, budgetId: string) {
  const result = await db.query('SELECT month, category_id, budgeted FROM assignments WHERE budget_id = $1', [budgetId]);
  return result.rows;
}

/** Upsert one assignment and return it. */
export async function upsertAssignmentReturning(db: Queryable, budgetId: string, month: string, categoryId: string, budgeted: number) {
  const result = await db.query(
    `INSERT INTO assignments (budget_id, month, category_id, budgeted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (budget_id, month, category_id)
       DO UPDATE SET budgeted = EXCLUDED.budgeted
       RETURNING month, category_id, budgeted`,
    [budgetId, month, categoryId, budgeted],
  );
  return result.rows[0];
}

/** Upsert one assignment (no read-back). */
export async function upsertAssignment(db: Queryable, budgetId: string, month: string, categoryId: string, budgeted: number): Promise<void> {
  await db.query(
    `INSERT INTO assignments (budget_id, month, category_id, budgeted)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (budget_id, month, category_id)
           DO UPDATE SET budgeted = EXCLUDED.budgeted`,
    [budgetId, month, categoryId, budgeted],
  );
}
