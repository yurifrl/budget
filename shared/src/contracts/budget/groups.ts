import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId, nameSchema, uuidSchema } from './schemas';
import { groupRowSchema, noContent } from './outputs';

export const groupsList = defineOperation({
  name: 'budget_groups_list',
  description: 'List category groups of a budget, in display order.',
  input: z.object({ budget_id: budgetId }),
  output: z.array(groupRowSchema),
  method: 'GET',
  path: '/groups',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const groupsCreate = defineOperation({
  name: 'budget_groups_create',
  description: 'Create a category group, sorted after the existing ones.',
  input: z.object({ budget_id: budgetId, name: nameSchema }),
  output: groupRowSchema,
  method: 'POST',
  path: '/groups',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const groupsRename = defineOperation({
  name: 'budget_groups_rename',
  description: 'Rename a category group.',
  input: z.object({ id: uuidSchema, budget_id: budgetId, name: nameSchema }),
  output: noContent,
  method: 'PATCH',
  path: '/groups/:id/name',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const groupsDelete = defineOperation({
  name: 'budget_groups_delete',
  description: 'Delete a category group and its categories (soft delete; history is kept).',
  input: z.object({ id: uuidSchema, budget_id: budgetId }),
  output: noContent,
  method: 'DELETE',
  path: '/groups/:id',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_ALL,
});
