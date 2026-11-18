import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId, nonNegativeMilliunitsSchema, snoozeMonthSchema, targetKindSchema, uuidSchema } from './schemas';

export const categoryTargetsList = defineOperation({
  name: 'budget_category_targets_list',
  description: 'List the funding targets of a budget (amount in integer MILLIUNITS, 12.34 = 12340).',
  input: z.object({ budget_id: budgetId }),
  method: 'GET',
  path: '/category-targets',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const categoryTargetsSet = defineOperation({
  name: 'budget_category_targets_set',
  description: 'Upsert the funding target of one category (weekly | monthly | yearly | custom; amount in integer MILLIUNITS, 12.34 = 12340, a whole number of cents, i.e. a multiple of 10).',
  input: z.object({
    categoryId: uuidSchema,
    budget_id: budgetId,
    kind: targetKindSchema,
    // Stored as cents (category_targets.amount_cents): sub-cent values cannot round-trip.
    amount: nonNegativeMilliunitsSchema.multipleOf(10, { message: 'must be a whole number of cents (a multiple of 10 milliunits)' }),
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
