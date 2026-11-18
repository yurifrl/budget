import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId, nameSchema, uuidSchema } from './schemas';
import { bundleRowSchema, noContent } from './outputs';

export const bundlesList = defineOperation({
  name: 'budget_bundles_list',
  description: 'List the category bundles of a budget (display-only roll-ups of categories inside one category group).',
  input: z.object({ budget_id: budgetId }),
  output: z.array(bundleRowSchema),
  method: 'GET',
  path: '/bundles',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const bundlesCreate = defineOperation({
  name: 'budget_bundles_create',
  description:
    'Create a bundle in a category group from at least 2 categories. Listed categories from another group are moved into group_id.',
  input: z.object({
    budget_id: budgetId,
    group_id: uuidSchema,
    name: nameSchema,
    category_ids: z.array(uuidSchema).min(2).max(200),
  }),
  output: bundleRowSchema,
  method: 'POST',
  path: '/bundles',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const bundlesRename = defineOperation({
  name: 'budget_bundles_rename',
  description: 'Rename a bundle.',
  input: z.object({ id: uuidSchema, budget_id: budgetId, name: nameSchema }),
  output: noContent,
  method: 'PATCH',
  path: '/bundles/:id/name',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const bundlesDelete = defineOperation({
  name: 'budget_bundles_delete',
  description: 'Ungroup a bundle: delete the bundle only; its categories stay in the group.',
  input: z.object({ id: uuidSchema, budget_id: budgetId }),
  output: noContent,
  method: 'DELETE',
  path: '/bundles/:id',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_ALL,
});

export const categoriesSetBundle = defineOperation({
  name: 'budget_categories_set_bundle',
  description:
    'Put categories into a bundle, or take them out with bundle_id null. Joining a bundle of another group moves the categories into that group. A bundle left with no categories is deleted.',
  input: z.object({
    budget_id: budgetId,
    category_ids: z.array(uuidSchema).min(1).max(200),
    bundle_id: uuidSchema.nullable(),
  }),
  output: noContent,
  method: 'PATCH',
  path: '/bundles/categories',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});
