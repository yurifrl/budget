import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId } from '../budget/schemas';
import { categorizeSettingsSchema } from './outputs';

/** The confidence threshold is applied when the queue is read, so changing it needs no re-run. */
export const categorizeSettingsGet = defineOperation({
  name: 'categorize_settings_get',
  description:
    'The budget\'s Categorize settings: the confidence threshold (0..1) below which suggestions are hidden. Defaults to 0.8; applied at read time, so no re-classification is needed after a change.',
  input: z.object({ budget_id: budgetId }),
  output: categorizeSettingsSchema,
  method: 'GET',
  path: '/categorize/settings',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const categorizeSettingsSet = defineOperation({
  name: 'categorize_settings_set',
  description:
    "Set the budget's confidence threshold (0..1). Suggestions already generated are filtered by it immediately on the next categorize_queue_list; nothing is re-billed.",
  input: z.object({ budget_id: budgetId, confidence_threshold: z.number().min(0).max(1) }),
  output: categorizeSettingsSchema,
  method: 'PUT',
  path: '/categorize/settings',
  kind: 'write',
  expose: EXPOSE_ALL,
});
