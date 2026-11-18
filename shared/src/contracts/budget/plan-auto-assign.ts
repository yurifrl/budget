import { z } from '../../zod';

import { defineOperation, EXPOSE_NO_MCP } from '../../operation-contract';
import { autoAssignRowSchema, budgetId, monthDateSchema } from './schemas';
import { noContent } from './outputs';

export const planAutoAssign = defineOperation({
  name: 'budget_plan_auto_assign',
  description:
    'Persist the absolute assigned amounts (rows[].assigned, integer MILLIUNITS, 12.34 = 12340) computed by one auto-assign strategy for a month, exactly as posted.',
  input: z.object({
    budget_id: budgetId,
    month: monthDateSchema,
    rows: z.array(autoAssignRowSchema).min(1).max(200),
  }),
  output: noContent,
  method: 'POST',
  path: '/plan-auto-assign',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});
