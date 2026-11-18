/**
 * Budget store: category notes and month notes. SQL only (moved verbatim from
 * routes/category-notes.ts and routes/month-notes.ts); every function takes a
 * Queryable.
 */
import type { Queryable } from '../../core/db';

export async function listCategoryNotes(db: Queryable, budgetId: string, month: string) {
  const result = await db.query('SELECT category_id, note FROM category_notes WHERE budget_id = $1 AND month = $2', [budgetId, month]);
  return result.rows;
}

export async function upsertCategoryNote(db: Queryable, budgetId: string, categoryId: string, month: string, note: string) {
  const result = await db.query(
    `INSERT INTO category_notes (budget_id, category_id, month, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (budget_id, category_id, month)
       DO UPDATE SET note = EXCLUDED.note
       RETURNING category_id, note`,
    [budgetId, categoryId, month, note],
  );
  return result.rows[0];
}

export async function listMonthNotes(db: Queryable, budgetId: string) {
  const result = await db.query('SELECT month, note FROM month_notes WHERE budget_id = $1 AND deleted = false', [budgetId]);
  return result.rows;
}

export async function upsertMonthNote(db: Queryable, budgetId: string, month: string, note: string) {
  const result = await db.query(
    `INSERT INTO month_notes (budget_id, month, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (budget_id, month)
       DO UPDATE SET note = EXCLUDED.note
       RETURNING month, note`,
    [budgetId, month, note],
  );
  return result.rows[0];
}
