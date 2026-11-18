import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId, nameSchema } from './schemas';
import { budgetDeletedSchema, budgetListRowSchema, budgetRowSchema, freshStartResultSchema } from './outputs';

const id = z.object({ id: budgetId });

export const budgetList = defineOperation({
  name: 'budget_list',
  description:
    'List the budgets the caller owns or that were shared with them (nothing else, whatever their role). Each row says whether the caller is the owner (is_owner), who the owner is (owner: user_id, name, email, avatar) and how many people are on it (member_count, owner included). Includes archived ones (archived_at set). Empty for someone with no budgets.',
  input: z.object({}),
  output: z.array(budgetListRowSchema),
  method: 'GET',
  path: '/budgets',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const budgetCreate = defineOperation({
  name: 'budget_create',
  description: 'Create a budget owned by the caller (who becomes its first member), with a default "Geral" category group.',
  input: z.object({ name: nameSchema }),
  output: budgetRowSchema,
  method: 'POST',
  path: '/budgets',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const budgetFreshStart = defineOperation({
  name: 'budget_fresh_start',
  description:
    'Fresh Start (owner only): archive the budget and create a replacement carrying over accounts, categories, payees, repeat rules and members while assignments reset.',
  input: z.object({ budget_id: budgetId }),
  output: freshStartResultSchema,
  method: 'POST',
  path: '/budgets/fresh-start',
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});

export const budgetRename = defineOperation({
  name: 'budget_rename',
  description: 'Rename a budget (owner only).',
  input: id.extend({ name: nameSchema }),
  output: budgetRowSchema,
  method: 'PATCH',
  path: '/budgets/:id',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const budgetArchive = defineOperation({
  name: 'budget_archive',
  description: 'Archive a budget (owner only; idempotent).',
  input: id,
  output: budgetRowSchema,
  method: 'POST',
  path: '/budgets/:id/archive',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const budgetUnarchive = defineOperation({
  name: 'budget_unarchive',
  description: 'Unarchive a budget (owner only; idempotent).',
  input: id,
  output: budgetRowSchema,
  method: 'POST',
  path: '/budgets/:id/unarchive',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const budgetDelete = defineOperation({
  name: 'budget_delete',
  description: 'Permanently delete a budget and everything in it (owner only).',
  input: id,
  output: budgetDeletedSchema,
  method: 'DELETE',
  path: '/budgets/:id',
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});
