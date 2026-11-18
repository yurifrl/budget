import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { monthNotesList, monthNotesSet } from '@shared/contracts/budget';
import { budgetRouter } from '../router';

export const operations = [
  implement(monthNotesList, async (_c, { budget_id }) => {
    const result = await pool.query(
      'SELECT month, note FROM month_notes WHERE budget_id = $1 AND deleted = false',
      [budget_id],
    );
    return result.rows;
  }),

  implement(monthNotesSet, async (_c, { budget_id, month, note }) => {
    const result = await pool.query(
      `INSERT INTO month_notes (budget_id, month, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (budget_id, month)
       DO UPDATE SET note = EXCLUDED.note
       RETURNING month, note`,
      [budget_id, month, note],
    );
    return result.rows[0];
  }),
];

export default budgetRouter('/month-notes', operations);
