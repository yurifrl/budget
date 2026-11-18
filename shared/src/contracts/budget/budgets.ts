import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId, nameSchema } from './schemas';

const id = z.object({ id: budgetId });

export const budgetList = defineOperation({
  name: 'budget_list',
  description: 'List the budgets the caller owns (admins see all). Includes archived ones (archived_at set).',
  input: z.object({}),
  method: 'GET',
  path: '/budgets',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const budgetCreate = defineOperation({
  name: 'budget_create',
  description: 'Create a budget owned by the caller, with a default "Geral" category group.',
  input: z.object({ name: nameSchema }),
  method: 'POST',
  path: '/budgets',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const budgetFreshStart = defineOperation({
  name: 'budget_fresh_start',
  description:
    'Fresh Start: archive the budget and create a replacement carrying over accounts, categories, payees and repeat rules while assignments reset.',
  input: z.object({ budget_id: budgetId }),
  method: 'POST',
  path: '/budgets/fresh-start',
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});

export const budgetRename = defineOperation({
  name: 'budget_rename',
  description: 'Rename a budget.',
  input: id.extend({ name: nameSchema }),
  method: 'PATCH',
  path: '/budgets/:id',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const budgetArchive = defineOperation({
  name: 'budget_archive',
  description: 'Archive a budget (idempotent).',
  input: id,
  method: 'POST',
  path: '/budgets/:id/archive',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const budgetUnarchive = defineOperation({
  name: 'budget_unarchive',
  description: 'Unarchive a budget (idempotent).',
  input: id,
  method: 'POST',
  path: '/budgets/:id/unarchive',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const budgetDelete = defineOperation({
  name: 'budget_delete',
  description: 'Permanently delete a budget and everything in it.',
  input: id,
  method: 'DELETE',
  path: '/budgets/:id',
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});
