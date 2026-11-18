/**
 * budgetApi slice: Payees: list, ledger, suggestion, rename/hide/merge, rename rules.
 * Injected into the one `budgetApi` (see ../api.ts); reducer path, tags and
 * cache behaviour are the slice's, unchanged by the split.
 */
import { contractRequest } from '@shared/contract-request';
import { payeesCreate, payeesDelete, payeesList, payeesMerge, payeesRename, payeesSetCategorization, payeesSetHidden, payeesSetRenameRule, payeesTransactions, payeeSuggestionGet } from '@shared/contracts/budget';
import type { CategorizationMode, MatchType } from '@shared/domain/payees';
import type { PayeeAdminRow, PayeeRow } from '../rows';
import { type BudgetScope, scopedList } from './base';
import type { PayeeSuggestionRow, PayeeTxnRow } from './types';
import { planApi } from './plan';

export const payeesApi = planApi.injectEndpoints({
  endpoints: (b) => ({
    getPayees: b.query<PayeeAdminRow[], BudgetScope>({
      query: scopedList(payeesList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Payees', id: budgetId }],
    }),

    /** A payee's transactions in the budget, newest first, paginated (syscd-app-kr7). */
    getPayeeTransactions: b.query<
      { rows: PayeeTxnRow[]; total: number },
      BudgetScope & { payeeId: string; limit?: number; offset?: number }
    >({
      query: ({ budgetId, payeeId, limit = 50, offset = 0 }) =>
        contractRequest(payeesTransactions, { id: payeeId, budget_id: budgetId, limit, offset }),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Payees', id: budgetId }],
    }),

    /** What the payee's next transaction would be categorized as (same
     * inference the server applies on transaction create, syscd-app-7pa). */
    getPayeeSuggestion: b.query<PayeeSuggestionRow, BudgetScope & { payeeId: string }>({
      query: ({ budgetId, payeeId }) => contractRequest(payeeSuggestionGet, { id: payeeId, budget_id: budgetId }),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Payees', id: budgetId }],
    }),

    addPayee: b.mutation<PayeeRow, BudgetScope & { name: string }>({
      query: ({ budgetId, name }) => contractRequest(payeesCreate, { budget_id: budgetId, name }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Payees', id: budgetId }],
    }),

    renamePayee: b.mutation<null, BudgetScope & { payeeId: string; name: string }>({
      query: ({ payeeId, name, budgetId }) => contractRequest(payeesRename, { id: payeeId, budget_id: budgetId, name }),
      // Transaction rows carry `payee_name`, so a rename must refresh the ledger too.
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Payees', id: budgetId },
        { type: 'Transactions', id: budgetId },
      ],
    }),

    /** Tombstone a payee (YNAB delta semantics); historical transactions keep their payee_id. */
    deletePayee: b.mutation<null, BudgetScope & { payeeId: string }>({
      query: ({ payeeId, budgetId }) => contractRequest(payeesDelete, { id: payeeId, budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Payees', id: budgetId }],
    }),

    /** Hide/unhide a payee — hidden payees vanish from pickers, reports keep them. */
    setPayeeHidden: b.mutation<null, BudgetScope & { payeeId: string; hidden: boolean }>({
      query: ({ payeeId, hidden, budgetId }) =>
        contractRequest(payeesSetHidden, { id: payeeId, budget_id: budgetId, hidden }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Payees', id: budgetId }],
    }),

    /**
     * Categorization behavior for new transactions (syscd-app-7pa): 'auto'
     * suggests from history, 'fixed' always uses default_category_id,
     * 'never' leaves new transactions uncategorized.
     */
    setPayeeCategorization: b.mutation<
      null,
      BudgetScope & {
        payeeId: string;
        categorizationMode: CategorizationMode;
        defaultCategoryId: string | null;
      }
    >({
      query: ({ payeeId, categorizationMode, defaultCategoryId, budgetId }) =>
        contractRequest(payeesSetCategorization, {
          id: payeeId,
          budget_id: budgetId,
          categorization_mode: categorizationMode,
          default_category_id: defaultCategoryId,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Payees', id: budgetId }],
    }),

    /**
     * Merge a duplicate payee into a target: all its transactions are
     * re-pointed and the source is soft-deleted. Server reports the count.
     */
    mergePayees: b.mutation<{ merged_transactions: number; source_deleted: boolean }, BudgetScope & { payeeId: string; targetPayeeId: string }>({
      query: ({ payeeId, targetPayeeId, budgetId }) =>
        contractRequest(payeesMerge, { id: payeeId, budget_id: budgetId, target_id: targetPayeeId }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Payees', id: budgetId },
        { type: 'Transactions', id: budgetId },
      ],
    }),

    /** Set the payee's own renaming rule (condition + matcher; the payee's name is the target). */
    setPayeeRenameRule: b.mutation<null, BudgetScope & { payeeId: string; matchType: MatchType; condition: string }>({
      query: ({ payeeId, budgetId, matchType, condition }) =>
        contractRequest(payeesSetRenameRule, { id: payeeId, budget_id: budgetId, match_type: matchType, condition }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Payees', id: budgetId }],
    }),
  }),
});
