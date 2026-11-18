import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId } from './schemas';

export const budgetRevisionGet = defineOperation({
  name: 'budget_revision_get',
  description:
    'Change revision of a budget: a counter that increases on ANY write to its data (any client, the sync worker, webhooks). Poll it to know when cached data is stale.',
  input: z.object({ budget_id: budgetId }),
  method: 'GET',
  path: '/budget-revision',
  kind: 'read',
  expose: EXPOSE_ALL,
});
