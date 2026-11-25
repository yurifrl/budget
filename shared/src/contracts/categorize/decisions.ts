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
const uniqueIds = (ids: string[]): boolean => new Set(ids).size === ids.length;
const items = z
  .array(categorizeDecisionItemSchema)
  .min(1)
  .max(1000)
  .refine((list) => uniqueIds(list.map((item) => item.transaction_id)), {
    message: 'transaction ids must be unique in one batch',
  });
const transactionIds = z.array(uuidSchema).min(1).max(1000).refine(uniqueIds, {
  message: 'transaction ids must be unique in one batch',
});
/**
 * Accept either explicit per-transaction pairs (`items`) or one
 * server-resolved bundle (`bundle_key`); the handler rejects both or neither.
 * Keeping one object (not a union) is what the operation catalog can address.
 */
const acceptInput = z.object({
  budget_id: budgetId,
  items: items.optional(),
  /** A bundle_key from the queue: its rows and top category are resolved on the server. */
  bundle_key: z.string().min(1).max(1024).optional(),
  /** The bundle's count as shown by the queue; a mismatch is a 409 with the current count. */
  expected_count: z.number().int().min(1).optional(),
});

export const categorizeAccept = defineOperation({
  name: 'categorize_accept',
  description:
    'Categorize a batch of transactions, either as explicit [{transaction_id, category_id}] or as one {bundle_key} resolved on the server from the queue (same bundle definition, inside the same transaction). Goes through the same transaction update path as budget_transactions_update (ownership, budget revision, category in this budget), plus: the category must be assignable (not hidden/internal/credit-card-payment) and the transaction must still need a category. All items are applied atomically; one bad item applies none. A bundle must carry expected_count from the queue page: if its current row count differs, the request is refused with categorize_bundle_changed (the body\'s params carry expected and actual counts) and nothing is applied. A bundle above 1000 rows is refused (categorize_bundle_too_large); fetch its rows through the queue filter and send explicit items in chunks. Records the decision (no time limit) so categorize_undo can reverse it, marks the matching suggestion accepted, or records the person\'s manual choice; other suggestions of the transaction are dismissed. A repeat of a pair this endpoint already applied is a no-op; a transaction that already carries a category without such a record is refused as already categorized. A decision is not expired by a register edit on its own: a row accepted and later cleared by hand is back in the queue with its earlier suggestions, a repeat accept then re-applies the category and replaces the record (no-op only while the category is still the one accept set), another pair is accepted, a skip replaces the stale record, and undo reports category_changed.',
  input: acceptInput,
  output: categorizeAcceptResultSchema,
  method: 'POST',
  path: '/categorize/accept',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const categorizeUndo = defineOperation({
  name: 'categorize_undo',
  description:
    'Undo a previous categorize_accept in one round trip: pass the transaction ids it applied. Reverses only a recorded accept, and only while the transaction still carries the category accept set and still needs a category apart from that one (not an inflow, transfer or split) and is not an upcoming repeat occurrence; it clears the category through the same transaction update path and restores the transaction\'s suggestions exactly (a recorded manual choice is removed). Everything else is left untouched and listed in `skipped` with a reason: no_decision (never accepted or already undone), category_changed (the category was changed or cleared by hand, or the row no longer needs a category), upcoming, skipped (a skip decision is never touched), not_found. A row accepted and later cleared by hand is left as is and reports category_changed. A decision has no time limit: undo works whenever these checks still hold.',
  input: z.object({ budget_id: budgetId, transaction_ids: transactionIds }),
  output: categorizeUndoResultSchema,
  method: 'POST',
  path: '/categorize/undo',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const categorizeSkip = defineOperation({
  name: 'categorize_skip',
  description:
    'Skip a transaction that is in the queue, whatever its state (has suggestions, below threshold, no suggestion, failed, not classified): its suggestions become dismissed and a skip decision is recorded, so it leaves every member\'s queue without getting a category and the engine never re-classifies it (a stale accept, accepted then cleared by hand, is replaced by the skip). Budget-wide, not per person. The decision has no time limit. Idempotent on repeat (dismissed: 0); 409 categorize_already_categorized only when the transaction already has a category.',
  input: z.object({ budget_id: budgetId, transaction_id: uuidSchema }),
  output: categorizeSkipResultSchema,
  method: 'POST',
  path: '/categorize/skip',
  kind: 'write',
  expose: EXPOSE_ALL,
});
