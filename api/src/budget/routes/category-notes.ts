/**
 * Category note routes — one freeform note per category per month (bead
 * syscd-app-nrg; the category inspector's Notes block). Upsert-only: an
 * emptied note overwrites with '' (YNAB clears notes the same way), so no
 * DELETE endpoint is needed.
 */

import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { categoryNotesList, categoryNotesSet } from '@shared/contracts/budget';
import { budgetRouter } from '../router';

export const operations = [
  /** All category notes for one month. */
  implement(categoryNotesList, async (_c, { budget_id, month }) => {
    const result = await pool.query(
      'SELECT category_id, note FROM category_notes WHERE budget_id = $1 AND month = $2',
      [budget_id, month],
    );
    return result.rows;
  }),

  /** Upsert one category's note for one month. */
  implement(categoryNotesSet, async (_c, { categoryId, budget_id, month, note }) => {
    const cat = await pool.query(
      'SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2 AND deleted = false',
      [categoryId, budget_id],
    );
    if (cat.rowCount === 0) throw new HttpError(404, 'category not found');

    const result = await pool.query(
      `INSERT INTO category_notes (budget_id, category_id, month, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (budget_id, category_id, month)
       DO UPDATE SET note = EXCLUDED.note
       RETURNING category_id, note`,
      [budget_id, categoryId, month, note],
    );
    return result.rows[0];
  }),
];

export default budgetRouter('/category-notes', operations);
