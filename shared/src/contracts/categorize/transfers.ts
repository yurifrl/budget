import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId } from '../budget/schemas';
import { uuidSchema } from '../../validation';
import { categorizeTransferRefusalResultSchema, categorizeTransferSuggestionsSchema } from './outputs';

/**
 * Jev's transfer suggestions, read for the Categorize page's Transfers section.
 * A suggestion is a pending one on a live, uncategorized transaction: it says a
 * row is really a transfer to (or from) one of the budget's own accounts. The
 * rows are grouped by that account and by direction so the page shows one row
 * per account pair; nothing here applies a suggestion, and a person's refusal
 * (the matcher's "not a transfer" mark) keeps the pair out of this read.
 */
export const categorizeTransferSuggestions = defineOperation({
  name: 'categorize_transfer_suggestions',
  description:
    "Jev's transfer suggestions for this budget, grouped by the account the money went to (on an outflow) or came from (on an inflow): the best pending suggestion of each row at or above the budget's confidence threshold, on live uncategorized transactions that still pass the run's candidate rule. Nothing is applied; accepting one is categorize_accept with transfer_account_id.",
  input: z.object({ budget_id: budgetId }),
  output: categorizeTransferSuggestionsSchema,
  method: 'GET',
  path: '/categorize/transfers',
  kind: 'read',
  expose: EXPOSE_ALL,
});

/**
 * "Not a transfer": the row is not a transfer, whatever account the suggestion
 * named (the account is recorded with the answer). Recording it keeps every
 * transfer for that row out of every later read, run and accept, and takes the
 * row's transfer suggestions away: an outflow returns to the category queue, an
 * inflow is not asked again.
 */
export const categorizeTransferRefuse = defineOperation({
  name: 'categorize_transfer_refuse',
  description:
    'Record that a transaction is not a transfer. transfer_account_id is the account the refused suggestion named (kept on record); the answer covers the whole row: no transfer to or from any account is suggested, listed or accepted for it again (accept answers categorize_transfer_refused) until the person links it in the register. An outflow goes back to the category queue; an inflow is not asked again. Repeating the answer changes nothing.',
  input: z.object({ budget_id: budgetId, transaction_id: uuidSchema, transfer_account_id: uuidSchema }),
  output: categorizeTransferRefusalResultSchema,
  method: 'POST',
  path: '/categorize/transfers/refuse',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});
