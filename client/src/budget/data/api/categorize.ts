/**
 * budgetApi slice: Categorize — the uncategorized queue with its suggestions
 * and bundles, accept/undo/skip decisions, the classification run and the
 * confidence threshold. Injected into the one `budgetApi` (see ../api.ts).
 *
 * Every amount on the wire is integer milliunits, dates are YYYY-MM-DD; the
 * contracts in `@shared/contracts/categorize` are the only shape definitions
 * (types below are their `z.infer` outputs). Accept and undo invalidate the
 * queue and the register rows (both read the transaction's category); skip
 * only the queue.
 */
import { contractRequest } from '@shared/contract-request';
import {
  categorizeAccept,
  categorizeQueueList,
  categorizeRunStart,
  categorizeRunStatus,
  categorizeSettingsGet,
  categorizeSettingsSet,
  categorizeSkip,
  categorizeUndo,
} from '@shared/contracts/categorize';
import type { OperationOutput } from '@shared/operation-contract';

import { aiApi } from './ai';
import type { BudgetScope } from './base';

export type CategorizeQueue = OperationOutput<typeof categorizeQueueList>;
export type CategorizeQueueRow = CategorizeQueue['rows'][number];
export type CategorizeBundle = CategorizeQueue['bundles'][number];
export type CategorizeCounts = CategorizeQueue['counts'];
export type CategorizeQueueState = CategorizeQueueRow['state'];
export type CategorizeSuggestion = CategorizeQueueRow['suggestions'][number];
export type CategorizeMerchantPanel = NonNullable<CategorizeQueueRow['merchant']>;
export type CategorizeRunStatus = OperationOutput<typeof categorizeRunStatus>;
export type CategorizeActiveRun = NonNullable<CategorizeRunStatus['active']>;
export type CategorizeFinishedRun = NonNullable<CategorizeRunStatus['last_finished']>;
export type CategorizeAiStatus = CategorizeRunStatus['ai'];
export type CategorizeSettings = OperationOutput<typeof categorizeSettingsGet>;
export type CategorizeAcceptResult = OperationOutput<typeof categorizeAccept>;
export type CategorizeDecisionItem = CategorizeAcceptResult['items'][number];
export type CategorizeUndoResult = OperationOutput<typeof categorizeUndo>;
export type CategorizeSkipResult = OperationOutput<typeof categorizeSkip>;
export type CategorizeRunStartResult = OperationOutput<typeof categorizeRunStart>;

/**
 * The queue reads transactions, category names/visibility and payee names, so
 * it provides those tags too: every local write that already invalidates one
 * of them (register edits, payee merge/rename, category hide/delete/rename)
 * refreshes the queue without editing each mutation. The revision watcher
 * covers writes from other clients through the `Categorize` tag.
 */
export const CATEGORIZE_QUEUE_TAGS = ['Categorize', 'Transactions', 'Categories', 'Payees'] as const; // eslint-disable-line budget-i18n/no-untranslated-string -- RTK cache tag names, never rendered

/**
 * The rail badge reads the queue with this limit just for `counts`. The API has
 * no count-only read, and every queue read recomputes counts and bundles over
 * the whole queue, so the badge is the cheapest to keep stale: it provides only
 * the `Categorize` tag, refreshed by accept/undo/skip and by the revision
 * watcher (a register edit shows within one poll), instead of refetching on
 * every local write the way the page's own read does.
 */
export const CATEGORIZE_COUNT_LIMIT = 1;

/** The cache tags a queue read provides: the badge's lightest read gets only `Categorize`. */
export function queueProvidedTags(
  budgetId: string,
  arg: { limit?: number; bundle?: string },
): { type: (typeof CATEGORIZE_QUEUE_TAGS)[number]; id: string }[] {
  const badge = arg.limit === CATEGORIZE_COUNT_LIMIT && arg.bundle === undefined;
  return (badge ? ['Categorize' as const] : CATEGORIZE_QUEUE_TAGS).map((type) => ({ type, id: budgetId })); // eslint-disable-line budget-i18n/no-untranslated-string -- RTK cache tag name, never rendered
}

export const categorizeApi = aiApi.injectEndpoints({
  endpoints: (b) => ({
    /** One queue page; counts and bundles cover the whole queue. `bundle` pages one bundle's rows. */
    getCategorizeQueue: b.query<
      CategorizeQueue,
      BudgetScope & { limit?: number; offset?: number; bundle?: string }
    >({
      query: ({ budgetId, limit, offset, bundle }) =>
        contractRequest(categorizeQueueList, { budget_id: budgetId, limit, offset, bundle }),
      providesTags: (_r, _e, { budgetId, limit, bundle }) => queueProvidedTags(budgetId, { limit, bundle }),
    }),

    /** File explicit pairs, or one server-resolved bundle with the count the queue showed. */
    acceptCategorize: b.mutation<
      CategorizeAcceptResult,
      BudgetScope & { items?: CategorizeDecisionItem[]; bundleKey?: string; expectedCount?: number }
    >({
      query: ({ budgetId, items, bundleKey, expectedCount }) =>
        contractRequest(categorizeAccept, {
          budget_id: budgetId,
          items,
          bundle_key: bundleKey,
          expected_count: expectedCount,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Categorize', id: budgetId },
        { type: 'Transactions', id: budgetId },
      ],
    }),

    /** Reverse a recorded accept; skips are never touched. */
    undoCategorize: b.mutation<CategorizeUndoResult, BudgetScope & { transactionIds: string[] }>({
      query: ({ budgetId, transactionIds }) =>
        contractRequest(categorizeUndo, { budget_id: budgetId, transaction_ids: transactionIds }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Categorize', id: budgetId },
        { type: 'Transactions', id: budgetId },
      ],
    }),

    /** Leave a queue row without a category; the engine never re-classifies it. */
    skipCategorize: b.mutation<CategorizeSkipResult, BudgetScope & { transactionId: string }>({
      query: ({ budgetId, transactionId }) =>
        contractRequest(categorizeSkip, { budget_id: budgetId, transaction_id: transactionId }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Categorize', id: budgetId }],
    }),

    /** Start or join the budget's run (coalesced; uses the budget owner's key). */
    startCategorizeRun: b.mutation<CategorizeRunStartResult, BudgetScope>({
      query: ({ budgetId }) => contractRequest(categorizeRunStart, { budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'CategorizeRun', id: budgetId }],
    }),

    /** Active progress, the last finished run, and whether AI is available (safe to poll). */
    getCategorizeRunStatus: b.query<CategorizeRunStatus, BudgetScope>({
      query: ({ budgetId }) => contractRequest(categorizeRunStatus, { budget_id: budgetId }),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'CategorizeRun', id: budgetId }],
    }),

    getCategorizeSettings: b.query<CategorizeSettings, BudgetScope>({
      query: ({ budgetId }) => contractRequest(categorizeSettingsGet, { budget_id: budgetId }),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Categorize', id: budgetId }],
    }),

    /** The threshold is applied when the queue is read; nothing is re-classified. */
    setCategorizeSettings: b.mutation<CategorizeSettings, BudgetScope & { confidenceThreshold: number }>({
      query: ({ budgetId, confidenceThreshold }) =>
        contractRequest(categorizeSettingsSet, {
          budget_id: budgetId,
          confidence_threshold: confidenceThreshold,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Categorize', id: budgetId }],
    }),
  }),
});
