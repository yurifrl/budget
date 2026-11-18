import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId, centsSchema, snoozeMonthSchema, targetKindSchema, uuidSchema } from './schemas';

export const categoryTargetsList = defineOperation({
  name: 'budget_category_targets_list',
  description: 'List the funding targets of a budget (amount_cents in CENTS).',
  input: z.object({ budget_id: budgetId }),
  method: 'GET',
  path: '/category-targets',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const categoryTargetsSet = defineOperation({
  name: 'budget_category_targets_set',
  description: 'Upsert the funding target of one category (weekly | monthly | yearly | custom; amount_cents in CENTS).',
  input: z.object({
    categoryId: uuidSchema,
    budget_id: budgetId,
    kind: targetKindSchema,
    amount_cents: centsSchema.min(0),
    snooze_month: snoozeMonthSchema,
    config: z.record(z.string(), z.unknown()).default({}),
  }),
  method: 'PUT',
  path: '/category-targets/:categoryId',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const categoryTargetsDelete = defineOperation({
  name: 'budget_category_targets_delete',
  description: 'Remove the funding target of one category.',
  input: z.object({ categoryId: uuidSchema, budget_id: budgetId }),
  method: 'DELETE',
  path: '/category-targets/:categoryId',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_ALL,
});
