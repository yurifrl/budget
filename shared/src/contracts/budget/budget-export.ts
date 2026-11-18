import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId } from './schemas';

export const budgetExport = defineOperation({
  name: 'budget_export',
  description:
    'Export the complete data of one budget as a backup payload (the same shape POST /budgets/restore accepts: groups, categories, accounts, transactions, assignments) plus extra sections restore ignores: budget, payees, category_targets, category_notes, month_notes, repeat_rules, splits.',
  input: z.object({ budget_id: budgetId }),
  method: 'GET',
  path: '/budgets/export',
  query: ['budget_id'],
  kind: 'read',
  expose: EXPOSE_ALL,
});
