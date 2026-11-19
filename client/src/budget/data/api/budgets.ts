/**
 * budgetApi slice: Budgets (list, revision, create/rename/archive/delete, fresh start, restore), the signed-in user probe and the USD→BRL rate.
 * Injected into the one `budgetApi` (see ../api.ts); reducer path, tags and
 * cache behaviour are the slice's, unchanged by the split.
 */
import { contractRequest } from '@shared/contract-request';
import { budgetArchive, budgetCreate, budgetDelete, budgetFreshStart, budgetList, budgetRename, budgetRestore, budgetRevisionGet, budgetUnarchive } from '@shared/contracts/budget';
import { ratesUsdBrl } from '@shared/contracts/rates/rates';
import { authMe } from '@shared/contracts/user/me';
import type { OperationOutput } from '@shared/operation-contract';
import { type CentsRestorePayload, restorePayloadToWire } from '../mapping';
import type { BudgetListRow, BudgetRow, UsdBrlRateRow } from '../rows';
import { baseApi } from './base';
import type { RestoreWire } from './types';

export const budgetsApi = baseApi.injectEndpoints({
  endpoints: (b) => ({
    getBudgets: b.query<BudgetListRow[], void>({
      query: () => contractRequest(budgetList, {}),
      providesTags: ['Budgets'],
    }),

    /**
     * The budget's server-side change revision (bumped by DB triggers on ANY
     * write). Provides no tags on purpose: invalidation must never refetch it.
     * Polled by useBudgetRevisionWatcher.
     */
    getBudgetRevision: b.query<{ revision: number }, { budgetId: string }>({
      query: ({ budgetId }) => contractRequest(budgetRevisionGet, { budget_id: budgetId }),
      keepUnusedDataFor: 0,
    }),

    /** Indicative USD→BRL rate for scheduled-row currency conversion (cached server-side). */
    getUsdBrlRate: b.query<UsdBrlRateRow, void>({
      query: () => contractRequest(ratesUsdBrl, {}),
      keepUnusedDataFor: 3600,
    }),

    /** New Budget instance (with a starter group so Plan isn't empty). */
    createBudget: b.mutation<BudgetRow, { name: string }>({
      query: ({ name }) => contractRequest(budgetCreate, { name }),
      invalidatesTags: ['Budgets'],
    }),

    /** Rename the active Budget instance (Plan Settings sub-view). */
    renameBudget: b.mutation<BudgetRow, { id: string; name: string }>({
      query: ({ id, name }) => contractRequest(budgetRename, { id, name }),
      invalidatesTags: ['Budgets'],
    }),

    /** Archive a budget (Configure pane) — moves it to the ARCHIVED section. */
    archiveBudget: b.mutation<BudgetRow, { id: string }>({
      query: ({ id }) => contractRequest(budgetArchive, { id }),
      invalidatesTags: ['Budgets'],
    }),

    /** Unarchive a budget (Configure pane) — back to the active list. */
    unarchiveBudget: b.mutation<BudgetRow, { id: string }>({
      query: ({ id }) => contractRequest(budgetUnarchive, { id }),
      invalidatesTags: ['Budgets'],
    }),

    /**
     * Permanently delete a budget and every row under it (server cascades).
     * The UI must gate this behind the typed "delete" confirmation.
     */
    deleteBudget: b.mutation<{ deleted: boolean }, { id: string }>({
      query: ({ id }) => contractRequest(budgetDelete, { id }),
      invalidatesTags: ['Budgets'],
    }),

    /**
     * Fresh Start (AUTHORED-06): archive the active budget — renamed to
     * "<name> <archive timestamp>" server-side, all data kept — and start a
     * new one with the original name plus a starter group. Response carries
     * the new budget to switch to.
     */
    freshStartBudget: b.mutation<
      { archived: BudgetRow; created: BudgetRow },
      { budgetId: string }
    >({
      query: ({ budgetId }) => contractRequest(budgetFreshStart, { budget_id: budgetId }),
      invalidatesTags: ['Budgets'],
    }),

    /**
     * Budget restore from a transfer payload (backup import). Replaces the
     * budget-scoped data: groups, categories, accounts, payees, transactions,
     * assignments, or only the plan / only the register (`sections`). Returns the counts written per table.
     */
    restoreBudget: b.mutation<
      OperationOutput<typeof budgetRestore>,
      // The transfer payload (transfer/payload.ts) is domain cents; sent as a format-2 (milliunit) document.
      // `sections` limits the restore to the plan and/or the register; omitted = everything.
      { budgetId: string; payload: CentsRestorePayload; sections?: RestoreWire['sections'] }
    >({
      query: ({ budgetId, payload, sections }) =>
        contractRequest(budgetRestore, {
          budget_id: budgetId,
          ...(restorePayloadToWire(payload) as RestoreWire),
          ...(sections ? { sections } : {}),
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Groups', id: budgetId },
        { type: 'Categories', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Transactions', id: budgetId },
        { type: 'Assignments', id: budgetId },
        { type: 'MonthNotes', id: budgetId },
        { type: 'Payees', id: budgetId },
        { type: 'Targets', id: budgetId },
        { type: 'CategoryNotes', id: budgetId },
        { type: 'Bundles', id: budgetId },
      ],
    }),

    /** Signed-in user (Account Settings sub-view — email display only). */
    getMe: b.query<OperationOutput<typeof authMe>, void>({
      query: () => contractRequest(authMe, {}),
    }),
  }),
});
