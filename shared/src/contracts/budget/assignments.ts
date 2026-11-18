import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { assignmentUpdateSchema, budgetId, milliunitsSchema, monthDateSchema, uuidSchema } from './schemas';

export const assignmentsList = defineOperation({
  name: 'budget_assignments_list',
  description: 'List every assignment (budgeted amount per category per month) of a budget. `budgeted` is returned in MILLIUNITS (cents x 10).',
  input: z.object({ budget_id: budgetId }),
  method: 'GET',
  path: '/assignments',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const assignmentsSet = defineOperation({
  name: 'budget_assignments_set',
  description: 'Set the budgeted amount of one category for one month (YYYY-MM-01). `budgeted` is an absolute amount in MILLIUNITS (cents x 10, e.g. 12.34 = 12340), unlike most other budget inputs, which are cents.',
  input: z.object({ budget_id: budgetId, month: monthDateSchema, category_id: uuidSchema, budgeted: milliunitsSchema }),
  method: 'POST',
  path: '/assignments',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const assignmentsBatch = defineOperation({
  name: 'budget_assignments_batch',
  description: 'Set several categories budgeted amounts for one month in a single transaction. Each `budgeted` is an absolute amount in MILLIUNITS (cents x 10, e.g. 12.34 = 12340).',
  input: z.object({
    budget_id: budgetId,
    month: monthDateSchema,
    updates: z.array(assignmentUpdateSchema).min(1).max(100),
  }),
  method: 'POST',
  path: '/assignments/batch',
  kind: 'write',
  expose: EXPOSE_ALL,
});
