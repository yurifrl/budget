import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId, categorizationModeSchema, matchTypeSchema, nameSchema, uuidSchema } from './schemas';

const scoped = z.object({ id: uuidSchema, budget_id: budgetId });

export const payeesList = defineOperation({
  name: 'budget_payees_list',
  description:
    'List payees with transaction counts, last-used date and inferred category. hidden=false lists visible payees only, true hidden only.',
  input: z.object({ budget_id: budgetId, hidden: z.string().optional() }),
  method: 'GET',
  path: '/payees',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const payeesCreate = defineOperation({
  name: 'budget_payees_create',
  description: 'Create a payee (rename rules apply to the name; an existing name is returned as-is).',
  input: z.object({
    budget_id: budgetId,
    name: nameSchema,
    default_category_id: uuidSchema.nullish(),
    hidden: z.boolean().optional(),
    categorization_mode: categorizationModeSchema.optional(),
  }),
  method: 'POST',
  path: '/payees',
  status: 201,
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const payeesTransactions = defineOperation({
  name: 'budget_payees_transactions',
  description: "Paginated ledger of one payee's transactions (limit 1..200, default 50). Returned `amount` is signed integer milliunits (12.34 = 12340).",
  input: z.object({
    id: uuidSchema,
    budget_id: budgetId,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  method: 'GET',
  path: '/payees/:id/transactions',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const payeesRename = defineOperation({
  name: 'budget_payees_rename',
  description: 'Rename a payee.',
  input: scoped.extend({ name: nameSchema }),
  method: 'PATCH',
  path: '/payees/:id/name',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const payeesSetHidden = defineOperation({
  name: 'budget_payees_set_hidden',
  description: 'Hide or show a payee.',
  input: scoped.extend({ hidden: z.boolean() }),
  method: 'PATCH',
  path: '/payees/:id/hidden',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const payeesSetCategorization = defineOperation({
  name: 'budget_payees_set_categorization',
  description: "Set a payee's auto-categorization mode and/or default category.",
  input: scoped.extend({
    categorization_mode: categorizationModeSchema.optional(),
    default_category_id: uuidSchema.nullable().optional(),
  }),
  method: 'PATCH',
  path: '/payees/:id/categorization',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const payeesDelete = defineOperation({
  name: 'budget_payees_delete',
  description: 'Delete a payee (soft delete; transactions keep their payee_id). Prefer merge.',
  input: scoped,
  method: 'DELETE',
  path: '/payees/:id',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_ALL,
});

export const payeesMerge = defineOperation({
  name: 'budget_payees_merge',
  description: 'Merge a payee into target_id: re-points its transactions, then deletes it.',
  input: scoped.extend({ target_id: uuidSchema }),
  method: 'POST',
  path: '/payees/:id/merge',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_ALL,
});

export const payeesSetRenameRule = defineOperation({
  name: 'budget_payees_set_rename_rule',
  description: "Set a payee's rename rule (imported text matching the condition resolves to this payee); empty condition clears it.",
  input: scoped.extend({ match_type: matchTypeSchema, condition: z.string().trim().max(200) }),
  method: 'PUT',
  path: '/payees/:id/rename-rule',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});
