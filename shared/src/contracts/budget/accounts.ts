import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { ACCOUNT_TYPES, accountLinkSchema, budgetId, milliunitsSchema, personSchema, uuidSchema } from './schemas';

export const accountsList = defineOperation({
  name: 'budget_accounts_list',
  description: 'List the accounts of a budget with their cleared/uncleared balances in integer MILLIUNITS (1/1000 of the currency unit; 12.34 = 12340).',
  input: z.object({ budget_id: budgetId }),
  method: 'GET',
  path: '/accounts',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const accountsCreate = defineOperation({
  name: 'budget_accounts_create',
  description:
    'Create an account. balance is in integer MILLIUNITS (12.34 = 12340); a non-zero value (stated as |balance| for debt types) books a "Starting Balance" transaction.',
  input: z.object({
    budget_id: budgetId,
    name: z.string().trim().min(1).max(200),
    type: z.enum(ACCOUNT_TYPES),
    on_budget: z.boolean().optional().default(true),
    balance: milliunitsSchema.optional().default(0),
    user_id: personSchema,
  }),
  method: 'POST',
  path: '/accounts',
  status: 201,
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const accountsUpdate = defineOperation({
  name: 'budget_accounts_update',
  description:
    'Edit an account: rename, note, close/reopen, override the working balance (working_balance, integer MILLIUNITS, 12.34 = 12340), or link/unlink a bank connection.',
  input: z.object({
    id: uuidSchema,
    budget_id: budgetId,
    name: z.string().trim().min(1).max(200).optional(),
    note: z.string().max(2000).nullable().optional(),
    closed: z.boolean().optional(),
    working_balance: milliunitsSchema.optional(),
    user_id: personSchema,
    link: accountLinkSchema.optional(),
  }),
  method: 'PATCH',
  path: '/accounts/:id',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const accountsReconcile = defineOperation({
  name: 'budget_accounts_reconcile',
  description:
    'Reconcile an account to a stated balance (stated_balance, integer MILLIUNITS, 12.34 = 12340): the stated balance is the account\'s working balance (cleared + uncleared); an adjustment transaction books the difference against it, and every row is locked as reconciled. Or lock everything as reconciled with reconcile_all.',
  input: z.object({
    id: uuidSchema,
    budget_id: budgetId,
    stated_balance: milliunitsSchema,
    reconcile_all: z.boolean().optional(),
  }),
  method: 'PATCH',
  path: '/accounts/:id/reconcile',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const accountsDelete = defineOperation({
  name: 'budget_accounts_delete',
  description: 'Delete a CLOSED account and every transaction it held (soft delete).',
  input: z.object({ id: uuidSchema, budget_id: budgetId }),
  method: 'DELETE',
  path: '/accounts/:id',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});
