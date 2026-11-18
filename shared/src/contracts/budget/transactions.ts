import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { balanceDeltasSchema, clearedSchema, isoDateSchema } from '../../validation';
import {
  budgetId,
  bulkTxnSchema,
  createTxnSchema,
  patchTxnSchema,
  subTxnListSchema,
  uuidSchema,
} from './schemas';

/**
 * Account balance deltas are OPTIONAL on every transaction write: when absent
 * the server derives them (domain/transactions.deriveDeltas); when supplied
 * they are applied verbatim, as the Expo client sends today.
 */
const deltas = balanceDeltasSchema.optional();

export const transactionsList = defineOperation({
  name: 'budget_transactions_list',
  description: 'List all live transactions of a budget (newest first) with their split legs. Returned `amount` fields are signed MILLIUNITS (cents x 10; negative = money out).',
  input: z.object({ budget_id: budgetId }),
  method: 'GET',
  path: '/transactions',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const transactionsCreate = defineOperation({
  name: 'budget_transactions_create',
  description:
    'Create a transaction. inflow_cents / outflow_cents are non-negative CENTS (inflow XOR outflow); deltas, when supplied, are balance changes in CENTS. Account balances are updated automatically unless deltas are supplied.',
  input: z.object({
    budget_id: budgetId,
    txn: createTxnSchema,
    deltas,
    subtransactions: subTxnListSchema.optional(),
  }),
  method: 'POST',
  path: '/transactions',
  status: 201,
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const transactionsBulk = defineOperation({
  name: 'budget_transactions_bulk_import',
  description:
    'Import a batch of parsed statement rows into one account (inflow_cents / outflow_cents in CENTS); dedupes on import ids and stores rows uncleared + unapproved.',
  input: z.object({ budget_id: budgetId, account_id: uuidSchema, txns: z.array(bulkTxnSchema).min(1).max(2000) }),
  method: 'POST',
  path: '/transactions/bulk',
  status: 201,
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const transactionsUpdate = defineOperation({
  name: 'budget_transactions_update',
  description:
    'Edit a transaction with a partial patch (and optionally replace its split legs); inflow_cents / outflow_cents in CENTS. Account balances are re-derived unless deltas are supplied (deltas are in CENTS).',
  input: z.object({
    id: uuidSchema,
    budget_id: budgetId,
    patch: patchTxnSchema,
    deltas,
    subtransactions: subTxnListSchema.optional(),
  }),
  method: 'PATCH',
  path: '/transactions/:id',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const transactionsDelete = defineOperation({
  name: 'budget_transactions_delete',
  description: 'Delete a transaction (soft delete). Account balances are reversed unless deltas are supplied (deltas are in CENTS).',
  input: z.object({ id: uuidSchema, budget_id: budgetId, deltas }),
  method: 'DELETE',
  path: '/transactions/:id',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_ALL,
});

/** Curated agent-friendly create: flat input, payee by NAME, one signed amount. */
export const transactionAdd = defineOperation({
  name: 'budget_transaction_add',
  description:
    'Add a transaction in one call. amount_cents is a signed integer in CENTS: negative = money out (spending), positive = money in. payee is a name (matched or created). date defaults to today (YYYY-MM-DD). Account balances update automatically.',
  input: z.object({
    budget_id: budgetId,
    account_id: uuidSchema,
    amount_cents: z.number().int().refine((n) => n !== 0, { message: 'amount_cents must be non-zero' }),
    payee: z.string().trim().min(1).max(200),
    category_id: uuidSchema.optional(),
    date: isoDateSchema.optional(),
    memo: z.string().max(500).optional(),
    cleared: clearedSchema.optional(),
  }),
  method: 'POST',
  path: '/transactions/add',
  status: 201,
  kind: 'write',
  expose: EXPOSE_ALL,
});
