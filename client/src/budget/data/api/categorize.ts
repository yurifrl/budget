/**
 * budgetApi slice: Categorize — the uncategorized queue with its suggestions
 * and bundles, accept/undo/skip decisions and the
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
  categorizeTransferRefuse,
  categorizeTransferSuggestions,
  categorizeUndo,
} from '@shared/contracts/categorize';
import type { OperationOutput } from '@shared/operation-contract';

import type { BudgetScope } from './base';
import { transfersApi } from './transfers';

export type CategorizeQueue = OperationOutput<typeof categorizeQueueList>;
export type CategorizeQueueRow = CategorizeQueue['rows'][number];
export type CategorizeBundle = CategorizeQueue['bundles'][number];
export type CategorizeCounts = CategorizeQueue['counts'];
export type CategorizeQueueState = CategorizeQueueRow['state'];
export type CategorizeSuggestion = CategorizeQueueRow['suggestions'][number];
export type CategorizeMerchantPanel = NonNullable<CategorizeQueueRow['merchant']>;
export type CategorizeSettings = OperationOutput<typeof categorizeSettingsGet>;
export type CategorizeTransfers = OperationOutput<typeof categorizeTransferSuggestions>;
/** One account-pair group of Jev's transfer answers, and one of its rows. */
export type CategorizeTransferGroup = CategorizeTransfers['groups'][number];
export type CategorizeTransferRow = CategorizeTransferGroup['rows'][number];
export type CategorizeTransferRefusal = OperationOutput<typeof categorizeTransferRefuse>;
export type CategorizeAcceptResult = OperationOutput<typeof categorizeAccept>;
export type CategorizeDecisionItem = CategorizeAcceptResult['items'][number];
export type CategorizeUndoResult = OperationOutput<typeof categorizeUndo>;
export type CategorizeSkipResult = OperationOutput<typeof categorizeSkip>;
export type CategorizeRunStatus = OperationOutput<typeof categorizeRunStatus>;

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

/** The tags a decision on the Categorize page invalidates (RTK cache names, never rendered). */
const CATEGORIZE_PAGE_TAGS = ['Categorize', 'Transactions', 'CategorizeRun'] as const; // eslint-disable-line budget-i18n/no-untranslated-string -- RTK cache tag names, never rendered

/**
 * Every read the Categorize page and its badges show: the queue (and its
 * counts), Jev's transfer answers, the matcher's pairs, the run card and the
 * rail badge. A decision changes what waits, so it invalidates all of them and
 * no view is left showing the state before the press.
 */
export function categorizePageTags(budgetId: string): {
  type: 'Categorize' | 'Transactions' | 'CategorizeRun';
  id: string;
}[] {
  return CATEGORIZE_PAGE_TAGS.map((type) => ({ type, id: budgetId }));
}

export const categorizeApi = transfersApi.injectEndpoints({
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
      invalidatesTags: (_r, _e, { budgetId }) => categorizePageTags(budgetId),
    }),

    /** Reverse a recorded accept; skips are never touched. */
    undoCategorize: b.mutation<CategorizeUndoResult, BudgetScope & { transactionIds: string[] }>({
      query: ({ budgetId, transactionIds }) =>
        contractRequest(categorizeUndo, { budget_id: budgetId, transaction_ids: transactionIds }),
      invalidatesTags: (_r, _e, { budgetId }) => categorizePageTags(budgetId),
    }),

    /**
     * Leave a row without a category; the engine never re-classifies it. Both the
     * queue and Jev's transfer answers are refreshed: a row skipped as a transfer
     * leaves that list too.
     */
    skipCategorize: b.mutation<CategorizeSkipResult, BudgetScope & { transactionId: string }>({
      query: ({ budgetId, transactionId }) =>
        contractRequest(categorizeSkip, { budget_id: budgetId, transaction_id: transactionId }),
      invalidatesTags: (_r, _e, { budgetId }) => categorizePageTags(budgetId),
    }),

    /**
     * Jev's transfer answers, grouped by the account they name and by direction.
     * A row here is never in the category queue: it is answered (or refused) as a
     * transfer, not filed under a category.
     */
    getCategorizeTransfers: b.query<CategorizeTransfers, BudgetScope>({
      query: ({ budgetId }) => contractRequest(categorizeTransferSuggestions, { budget_id: budgetId }),
      providesTags: (_r, _e, { budgetId }) => [
        { type: 'Categorize', id: budgetId },
        { type: 'Transactions', id: budgetId },
      ],
    }),

    /**
     * "Not a transfer" for one row and one account: the pair is recorded so a
     * later run never offers that account again, and an outflow goes back to the
     * category side of the page.
     */
    refuseCategorizeTransfer: b.mutation<
      CategorizeTransferRefusal,
      BudgetScope & { transactionId: string; transferAccountId: string }
    >({
      query: ({ budgetId, transactionId, transferAccountId }) =>
        contractRequest(categorizeTransferRefuse, {
          budget_id: budgetId,
          transaction_id: transactionId,
          transfer_account_id: transferAccountId,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => categorizePageTags(budgetId),
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

    /**
     * The run's state, the key situation and its progress. The page polls this
     * while a run is in flight (`pollingInterval` in the hook).
     */
    getCategorizeRun: b.query<CategorizeRunStatus, BudgetScope>({
      query: ({ budgetId }) => contractRequest(categorizeRunStatus, { budget_id: budgetId }),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'CategorizeRun', id: budgetId }],
    }),

    /**
     * Queue a run for `count` transactions (or everything waiting); while one is
     * in flight the server answers that same run.
     */
    startCategorizeRun: b.mutation<CategorizeRunStatus, BudgetScope & { count: 'all' | number }>({
      query: ({ budgetId, count }) =>
        contractRequest(categorizeRunStart, { budget_id: budgetId, count }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'CategorizeRun', id: budgetId },
        { type: 'Categorize', id: budgetId },
      ],
    }),
  }),
});
