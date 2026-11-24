import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId } from '../budget/schemas';
import { uuidSchema } from '../../validation';
import {
  categorizeAcceptResultSchema,
  categorizeDecisionItemSchema,
  categorizeSkipResultSchema,
  categorizeUndoResultSchema,
} from './outputs';

/**
 * The batch limit is a request-size bound, not a product limit: accept-all is
 * expected to send chunks. Every item is applied in ONE database transaction,
 * so a failure leaves nothing applied.
 */
const items = z.array(categorizeDecisionItemSchema).min(1).max(1000);

export const categorizeAccept = defineOperation({
  name: 'categorize_accept',
  description:
    'Categorize a batch of transactions (one row, a bundle or accept-all): [{transaction_id, category_id}]. Goes through the same transaction update path as budget_transactions_update (ownership, budget revision, category in this budget), plus: the category must be assignable (not hidden/internal/credit-card-payment) and the transaction must still need a category. All items are applied atomically; one bad item applies none. Marks the matching suggestion accepted, or records the person\'s manual choice; other suggestions of the transaction are dismissed. Idempotent: repeating an already-applied pair succeeds. The answer carries exactly what categorize_undo needs.',
  input: z.object({ budget_id: budgetId, items }),
  output: categorizeAcceptResultSchema,
  method: 'POST',
  path: '/categorize/accept',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const categorizeUndo = defineOperation({
  name: 'categorize_undo',
  description:
    'Undo a previous categorize_accept in one round trip: pass the items it returned. Clears the category through the same transaction update path and restores the transaction\'s suggestions to pending (a recorded manual choice is removed). Idempotent when the category is already clear. An item whose category changed since the accept is left untouched and listed in `skipped`; every other item is applied atomically.',
  input: z.object({ budget_id: budgetId, items }),
  output: categorizeUndoResultSchema,
  method: 'POST',
  path: '/categorize/undo',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const categorizeSkip = defineOperation({
  name: 'categorize_skip',
  description:
    'Skip a transaction\'s suggestions: all its pending suggestions become dismissed, so it leaves the queue without getting a category and the engine never re-classifies it (a dismissed suggestion freezes the transaction, like an accepted one). This is budget-wide, not per person: everyone\'s queue hides it. Idempotent on repeat (dismissed: 0); 409 categorize_nothing_to_skip when it has no suggestions to dismiss (categorize it by hand instead).',
  input: z.object({ budget_id: budgetId, transaction_id: uuidSchema }),
  output: categorizeSkipResultSchema,
  method: 'POST',
  path: '/categorize/skip',
  kind: 'write',
  expose: EXPOSE_ALL,
});
