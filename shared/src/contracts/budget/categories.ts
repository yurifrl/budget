import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId, categoryMoveSchema, categoryTargetInputSchema, nameSchema, personSchema, uuidSchema } from './schemas';

const scoped = z.object({ id: uuidSchema, budget_id: budgetId });

export const categoriesList = defineOperation({
  name: 'budget_categories_list',
  description: 'List the categories of a budget, in display order. Goal amounts (goal_target) are returned in MILLIUNITS (cents x 10).',
  input: z.object({ budget_id: budgetId }),
  method: 'GET',
  path: '/categories',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const categoriesCreate = defineOperation({
  name: 'budget_categories_create',
  description: 'Create a category inside a category group, optionally owned by a budget member (user_id; omit or null = Shared).',
  input: z.object({
    budget_id: budgetId,
    group_id: uuidSchema,
    name: nameSchema,
    sort_order: z.number().int().min(0),
    user_id: personSchema,
  }),
  method: 'POST',
  path: '/categories',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const categoriesSetPerson = defineOperation({
  name: 'budget_categories_set_person',
  description: "Set which budget member owns a category (user_id), or null for Shared. user_id must be a member of the budget.",
  input: scoped.extend({ user_id: uuidSchema.nullable() }),
  method: 'PATCH',
  path: '/categories/:id/person',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const categoriesSetGroupPerson = defineOperation({
  name: 'budget_categories_set_group_person',
  description: 'Assign every category of a group to one budget member (user_id), or null for Shared.',
  input: z.object({ budget_id: budgetId, group_id: uuidSchema, user_id: uuidSchema.nullable() }),
  method: 'PATCH',
  path: '/categories/group-person',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const categoriesSetNotes = defineOperation({
  name: 'budget_categories_set_notes',
  description: "Set (or clear, when omitted) a category's note.",
  input: scoped.extend({ notes: z.string().max(10_000).optional() }),
  method: 'PATCH',
  path: '/categories/:id/notes',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const categoriesRename = defineOperation({
  name: 'budget_categories_rename',
  description: 'Rename a category.',
  input: scoped.extend({ name: nameSchema }),
  method: 'PATCH',
  path: '/categories/:id/name',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const categoriesSetTarget = defineOperation({
  name: 'budget_categories_set_target',
  description: "Set a category's goal from {amount_cents (CENTS), cadence, by_date, behavior}, or clear it with null.",
  input: scoped.extend({ target: categoryTargetInputSchema }),
  method: 'PATCH',
  path: '/categories/:id/target',
  query: ['budget_id'],
  bodyKey: 'target',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const categoriesReorder = defineOperation({
  name: 'budget_categories_reorder',
  description: 'Bulk-move categories between groups / sort positions in one transaction.',
  input: z.object({ budget_id: budgetId, moves: z.array(categoryMoveSchema).min(1) }),
  method: 'PATCH',
  path: '/categories/reorder',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const categoriesSetHidden = defineOperation({
  name: 'budget_categories_set_hidden',
  description: 'Hide or show a category.',
  input: scoped.extend({ hidden: z.boolean() }),
  method: 'PATCH',
  path: '/categories/:id/hidden',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const categoriesDelete = defineOperation({
  name: 'budget_categories_delete',
  description: 'Delete a category (soft delete; transactions and assignments keep their history).',
  input: scoped,
  method: 'DELETE',
  path: '/categories/:id',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_ALL,
});
