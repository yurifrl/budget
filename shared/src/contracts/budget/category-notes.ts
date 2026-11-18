import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId, monthDateSchema, noteSchema, uuidSchema } from './schemas';

export const categoryNotesList = defineOperation({
  name: 'budget_category_notes_list',
  description: 'List all category notes of one month (YYYY-MM-01).',
  input: z.object({ budget_id: budgetId, month: monthDateSchema }),
  method: 'GET',
  path: '/category-notes',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const categoryNotesSet = defineOperation({
  name: 'budget_category_notes_set',
  description: "Upsert one category's note for one month; an empty string clears it.",
  input: z.object({ categoryId: uuidSchema, budget_id: budgetId, month: monthDateSchema, note: noteSchema }),
  method: 'PUT',
  path: '/category-notes/:categoryId',
  query: ['budget_id', 'month'],
  kind: 'write',
  expose: EXPOSE_ALL,
});
