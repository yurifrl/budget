import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { clearedSchema, isoDateSchema } from '../../validation';
import {
  budgetId,
  bulkTxnSchema,
  createTxnSchema,
  milliunitsSchema,
  patchTxnSchema,
  subTxnListSchema,
  uuidSchema,
} from './schemas';
import { bulkImportResultSchema, noContent, transactionDetailsSchema, transactionRowSchema } from './outputs';

/**
 * Account balance deltas are always derived by the server from the stored
 * rows (domain/transactions.deriveDeltas). Clients cannot supply them: the
 * schemas below are non-strict, so a stray `deltas` key is stripped, never
 * applied.
 */

export const transactionsList = defineOperation({
  name: 'budget_transactions_list',
  description: 'List all live transactions of a budget (newest first) with their split legs, plus the not-yet-billed installments of card installment purchases as derived rows (`upcoming` true, `installment` set; never stored, in no balance). `amount` fields (parent and split legs) are signed milliunits (1/1000 of the currency unit, 12.34 = 12340; negative = money out).',
  input: z.object({ budget_id: budgetId }),
  output: z.array(transactionRowSchema),
  method: 'GET',
  path: '/transactions',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const transactionsGet = defineOperation({
  name: 'budget_transactions_get',
  description:
    "One transaction of a budget with everything known about it (also soft-deleted rows): the register row with payee, category and account names and its split legs, plus `import` for a bank-imported row (provider, the bank's transaction id, connection, bank name, sync state imported/edited, the last synced fields and the provider's full raw transaction object; null for a row entered by hand). `amount` fields are signed milliunits (1/1000 of the currency unit, 12.34 = 12340; negative = money out).",
  input: z.object({ id: uuidSchema, budget_id: budgetId }),
  output: transactionDetailsSchema,
  method: 'GET',
  path: '/transactions/:id',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const transactionsCreate = defineOperation({
  name: 'budget_transactions_create',
  description:
    'Create a transaction. txn.inflow / txn.outflow (and split legs\' inflow / outflow) are integer MILLIUNITS (1/1000 of the currency unit; 12.34 = 12340), inflow XOR outflow. Account balances are updated automatically.',
  input: z.object({
    budget_id: budgetId,
    txn: createTxnSchema,
    subtransactions: subTxnListSchema.optional(),
  }),
  output: transactionRowSchema,
  method: 'POST',
  path: '/transactions',
  status: 201,
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const transactionsBulk = defineOperation({
  name: 'budget_transactions_bulk_import',
  description:
    'Import a batch of parsed statement rows into one account (inflow / outflow in integer MILLIUNITS, 12.34 = 12340); dedupes on import ids and stores rows uncleared + unapproved.',
  input: z.object({ budget_id: budgetId, account_id: uuidSchema, txns: z.array(bulkTxnSchema).min(1).max(2000) }),
  output: bulkImportResultSchema,
  method: 'POST',
  path: '/transactions/bulk',
  status: 201,
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const transactionsUpdate = defineOperation({
  name: 'budget_transactions_update',
  description:
    'Edit a transaction with a partial patch (and optionally replace its split legs); inflow / outflow in integer MILLIUNITS (12.34 = 12340). Account balances are re-derived automatically.',
  input: z.object({
    id: uuidSchema,
    budget_id: budgetId,
    patch: patchTxnSchema,
    subtransactions: subTxnListSchema.optional(),
  }),
  output: noContent,
  method: 'PATCH',
  path: '/transactions/:id',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const transactionsDelete = defineOperation({
  name: 'budget_transactions_delete',
  description: 'Delete a transaction (soft delete). Account balances are reversed automatically.',
  input: z.object({ id: uuidSchema, budget_id: budgetId }),
  output: noContent,
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
    'Add a transaction in one call. amount is a signed integer in MILLIUNITS (1/1000 of the currency unit; -12.34 = -12340): negative = money out (spending), positive = money in. payee is a name (matched or created). date defaults to today (YYYY-MM-DD). Account balances update automatically.',
  input: z.object({
    budget_id: budgetId,
    account_id: uuidSchema,
    amount: milliunitsSchema.refine((n) => n !== 0, { message: 'amount must be non-zero' }),
    payee: z.string().trim().min(1).max(200),
    category_id: uuidSchema.optional(),
    date: isoDateSchema.optional(),
    memo: z.string().max(500).optional(),
    cleared: clearedSchema.optional(),
  }),
  output: transactionRowSchema,
  method: 'POST',
  path: '/transactions/add',
  status: 201,
  kind: 'write',
  expose: EXPOSE_ALL,
});
