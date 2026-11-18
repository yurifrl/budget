import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId, frequencySchema, isoDateSchema, milliunitsSchema, uuidSchema } from './schemas';
import { noContent, repeatGenerateResultSchema, repeatRuleRowSchema } from './outputs';

export const repeatRulesList = defineOperation({
  name: 'budget_repeat_rules_list',
  description: 'List the live repeat (recurring transaction) rules of a budget. Returned `amount` is signed integer milliunits (12.34 = 12340; negative = money out).',
  input: z.object({ budget_id: budgetId }),
  output: z.array(repeatRuleRowSchema),
  method: 'GET',
  path: '/repeat-rules',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const repeatRulesCreate = defineOperation({
  name: 'budget_repeat_rules_create',
  description:
    'Create a repeat rule from a template (needs next_due_date) or from an existing transaction (attach_transaction_id, "Make Repeating"). outflow / inflow are integer MILLIUNITS (12.34 = 12340), inflow XOR outflow.',
  input: z.object({
    budget_id: budgetId,
    account_id: uuidSchema,
    payee: z.string(),
    category_id: uuidSchema.nullable(),
    memo: z.string().nullable(),
    outflow: milliunitsSchema,
    inflow: milliunitsSchema,
    frequency: frequencySchema,
    month_last_day: z.boolean().default(false),
    // When set, the rule template is derived from this anchor transaction
    // (Make Repeating) and the template fields above are ignored.
    attach_transaction_id: uuidSchema.nullable().optional(),
    next_due_date: isoDateSchema.optional(),
  }),
  output: repeatRuleRowSchema,
  method: 'POST',
  path: '/repeat-rules',
  status: 201,
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const repeatRulesGenerate = defineOperation({
  name: 'budget_repeat_rules_generate',
  description: 'Materialize due occurrences of every repeat rule now (idempotent).',
  input: z.object({ budget_id: budgetId }),
  output: repeatGenerateResultSchema,
  method: 'POST',
  path: '/repeat-rules/generate',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const repeatRulesDelete = defineOperation({
  name: 'budget_repeat_rules_delete',
  description: 'Delete a repeat rule; its pending upcoming occurrences are removed.',
  input: z.object({ id: uuidSchema, budget_id: budgetId }),
  output: noContent,
  method: 'DELETE',
  path: '/repeat-rules/:id',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_ALL,
});
