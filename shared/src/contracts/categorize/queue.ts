import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId } from '../budget/schemas';
import { categorizeQueueSchema } from './outputs';

export const categorizeQueueList = defineOperation({
  name: 'categorize_queue_list',
  description:
    "The budget's transactions that still need a category, newest first, with their own data exactly as stored (payee, date, amount in integer MILLIUNITS, account, memo, raw bank description — never masked or truncated; masking applies only to prompts). Each row carries the merchant-panel facts the bank sent, its pending suggestions at/above the budget's confidence threshold (category id, name, confidence, reason, source) and a state: has_suggestions | below_threshold | no_suggestion | failed | not_classified. Bundles group transactions with the same payee and the same top suggestion; they and the header counts cover the WHOLE queue, not the requested page. A transaction a person accepted or skipped is not in the queue.",
  input: z.object({
    budget_id: budgetId,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  output: categorizeQueueSchema,
  method: 'GET',
  path: '/categorize/queue',
  kind: 'read',
  expose: EXPOSE_ALL,
});
