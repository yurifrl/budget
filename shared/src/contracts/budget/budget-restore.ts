import { z } from '../../zod';

import { defineOperation, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId, restorePayloadShape } from './schemas';

export const budgetRestore = defineOperation({
  name: 'budget_restore',
  description:
    'Restore a budget from a backup payload: wipes every budget-scoped table and re-creates the payload in one transaction. Payload amounts (outflow, inflow, budgeted) are in CENTS.',
  input: z.object({ budget_id: budgetId, ...restorePayloadShape }),
  method: 'POST',
  path: '/budgets/restore',
  status: 201,
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});
