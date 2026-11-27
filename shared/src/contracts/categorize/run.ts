import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId } from '../budget/schemas';
import { categorizeRunStatusSchema } from './outputs';

/**
 * The Categorize run: one background job per budget that asks Jev about the
 * transactions still needing a category. Starting is idempotent while a run is
 * in flight (a second start answers the running one), and the run only ever
 * writes suggestions — never a category on a transaction.
 */
export const categorizeRunStart = defineOperation({
  name: 'categorize_run_start',
  description:
    'Start a background run that asks Jev for category suggestions on this budget\'s uncategorized transactions. `count` is how many transactions the run may take: a number you choose, or "all" for everything waiting. There is no per-run size cap; a rolling-hour safety limit (5000 transactions per budget) trims the run and refuses a start with no allowance left. Returns at once with the run\'s status; while a run is in flight, starting again answers that same run. Needs a Jev key: the budget owner\'s saved one, or the shared key when the shared-jev-key feature is on.',
  input: z.object({
    budget_id: budgetId,
    count: z
      .union([z.number().int().positive(), z.literal('all')])
      .default('all')
      .describe('How many transactions this run may take: a positive number, or "all" for everything waiting.'),
  }),
  output: categorizeRunStatusSchema,
  method: 'POST',
  path: '/categorize/run',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

/** Whether a key is available, and how far the current or latest run got. */
export const categorizeRunStatus = defineOperation({
  name: 'categorize_run_status',
  description:
    "The budget's Categorize run: whether a Jev key is available (and why not, when none is), plus the state and done/total/failures of the run in flight or the most recent one.",
  input: z.object({ budget_id: budgetId }),
  output: categorizeRunStatusSchema,
  method: 'GET',
  path: '/categorize/run',
  kind: 'read',
  expose: EXPOSE_ALL,
});
