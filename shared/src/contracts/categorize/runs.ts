import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId } from '../budget/schemas';
import { categorizeRunStartResultSchema, categorizeRunStatusOutputSchema } from './outputs';

/**
 * Start (or join) the budget's categorization run. Any member may start it; it
 * always uses the BUDGET OWNER's AI key (or the shared key when that feature is
 * enabled for the owner), whoever asks. Coalesced: starting while a run is
 * queued/running returns that run with `created: false`.
 *
 * There is deliberately NO re-classify flag: the engine's `force` would re-bill
 * the newest capped batch on every click, and no client needs it yet.
 *
 * With no usable key for the owner the answer is 409 categorize_ai_unavailable;
 * the body of categorize_run_status carries the precise reason for the page's
 * empty state.
 */
export const categorizeRunStart = defineOperation({
  name: 'categorize_run_start',
  description:
    "Start or join the budget's AI categorization run. Any member may start it; the run uses the budget owner's AI key (or the shared key when available to the owner). Coalesced: an existing queued/running run is returned with created=false. No re-classify option: a run only classifies transactions without suggestions/attempts, up to its per-run cap; the rest waits for the next run. 409 categorize_ai_unavailable when the budget owner has no usable AI key.",
  input: z.object({ budget_id: budgetId }),
  output: categorizeRunStartResultSchema,
  method: 'POST',
  path: '/categorize/run',
  kind: 'write',
  // A paid background job, like repeat_rules_generate: CLI yes, MCP no.
  expose: EXPOSE_NO_MCP,
});

/** Active progress plus the last finished run, and whether AI is available for this budget. */
export const categorizeRunStatus = defineOperation({
  name: 'categorize_run_status',
  description:
    "The budget's categorization run: active run with progress (done/total recorded by the worker; 0/0 while queued), the last finished run and its counts, and whether AI is available for this budget (and if not, why: no usable key for the owner). Safe to poll; never calls a provider.",
  input: z.object({ budget_id: budgetId }),
  output: categorizeRunStatusOutputSchema,
  method: 'GET',
  path: '/categorize/run',
  kind: 'read',
  expose: EXPOSE_ALL,
});
