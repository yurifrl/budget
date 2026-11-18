import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { assignmentUpdateSchema, budgetId, milliunitsSchema, monthDateSchema, uuidSchema } from './schemas';
import { assignmentRowSchema, noContent } from './outputs';

export const assignmentsList = defineOperation({
  name: 'budget_assignments_list',
  description: 'List every assignment (budgeted amount per category per month) of a budget. `budgeted` is integer milliunits (12.34 = 12340).',
  input: z.object({ budget_id: budgetId }),
  output: z.array(assignmentRowSchema),
  method: 'GET',
  path: '/assignments',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const assignmentsSet = defineOperation({
  name: 'budget_assignments_set',
  description: 'Set the budgeted amount of one category for one month (YYYY-MM-01). `budgeted` is an absolute amount in integer MILLIUNITS (12.34 = 12340).',
  input: z.object({ budget_id: budgetId, month: monthDateSchema, category_id: uuidSchema, budgeted: milliunitsSchema }),
  output: assignmentRowSchema,
  method: 'POST',
  path: '/assignments',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const assignmentsBatch = defineOperation({
  name: 'budget_assignments_batch',
  description: 'Set several categories budgeted amounts for one month in a single transaction. Each `budgeted` is an absolute amount in integer MILLIUNITS (12.34 = 12340).',
  input: z.object({
    budget_id: budgetId,
    month: monthDateSchema,
    updates: z.array(assignmentUpdateSchema).min(1).max(100),
  }),
  output: noContent,
  method: 'POST',
  path: '/assignments/batch',
  kind: 'write',
  expose: EXPOSE_ALL,
});
