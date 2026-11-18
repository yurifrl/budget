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
import { liveCategoryInBudget } from '../store/categories';
import { listCategoryNotes, upsertCategoryNote } from '../store/notes';

export const operations = [
  /** All category notes for one month. */
  implement(categoryNotesList, async (_c, { budget_id, month }) => listCategoryNotes(pool, budget_id, month)),

  /** Upsert one category's note for one month. */
  implement(categoryNotesSet, async (_c, { categoryId, budget_id, month, note }) => {
    if (!(await liveCategoryInBudget(pool, categoryId, budget_id))) throw new HttpError(404, 'category not found');

    return upsertCategoryNote(pool, budget_id, categoryId, month, note);
  }),
];

export default budgetRouter('/category-notes', operations);
