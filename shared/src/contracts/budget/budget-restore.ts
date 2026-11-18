import { z } from '../../zod';

import { defineOperation, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId, restorePayloadShape } from './schemas';
import { restoreCountsSchema } from './outputs';

export const budgetRestore = defineOperation({
  name: 'budget_restore',
  description:
    'Restore a budget from a backup payload (owner only): wipes every budget-scoped table and re-creates the payload in one transaction. Payload amounts (transactions[].outflow / inflow, assignments[].budgeted) are integer MILLIUNITS when format_version is 2 (what budget_export writes); a backup without format_version (or 1) is the legacy format in CENTS and is converted.',
  input: z.object({ budget_id: budgetId, ...restorePayloadShape }),
  output: restoreCountsSchema,
  method: 'POST',
  path: '/budgets/restore',
  status: 201,
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});
