import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId, monthDateSchema, noteSchema } from './schemas';
import { monthNoteRowSchema } from './outputs';

export const monthNotesList = defineOperation({
  name: 'budget_month_notes_list',
  description: 'List the monthly notes of a budget.',
  input: z.object({ budget_id: budgetId }),
  output: z.array(monthNoteRowSchema),
  method: 'GET',
  path: '/month-notes',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const monthNotesSet = defineOperation({
  name: 'budget_month_notes_set',
  description: 'Upsert the note of one month (YYYY-MM-01).',
  input: z.object({ budget_id: budgetId, month: monthDateSchema, note: noteSchema }),
  output: monthNoteRowSchema,
  method: 'POST',
  path: '/month-notes',
  kind: 'write',
  expose: EXPOSE_ALL,
});
