import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId, uuidSchema } from './schemas';

export const payeeSuggestionGet = defineOperation({
  name: 'budget_payee_suggestions_get',
  description: "What category the payee's next transaction would be auto-categorized as.",
  input: z.object({ id: uuidSchema, budget_id: budgetId }),
  method: 'GET',
  path: '/payee-suggestions/:id',
  kind: 'read',
  expose: EXPOSE_ALL,
});
