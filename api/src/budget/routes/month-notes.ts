import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { monthNotesList, monthNotesSet } from '@shared/contracts/budget';
import { budgetRouter } from '../router';
import { listMonthNotes, upsertMonthNote } from '../store/notes';

export const operations = [
  implement(monthNotesList, async (_c, { budget_id }) => listMonthNotes(pool, budget_id)),

  implement(monthNotesSet, async (_c, { budget_id, month, note }) => upsertMonthNote(pool, budget_id, month, note)),
];

export default budgetRouter('/month-notes', operations);
