/**
 * budgetApi — the Budget app's RTK Query api, assembled from per-area slices
 * under `./api/` (phase 5c, G9): `base` creates the api (reducer path
 * `budgetApi`, base query, tags, refetch policy) and `budgets`, `members`,
 * `plan`, `payees`, `register`, `connections` and `transfers` inject their endpoints, in
 * that order. This file is the only import path the app uses: the api, every
 * hook and the endpoint types are re-exported here under their original
 * names, so splitting the slice changed no import outside `data/`.
 *
 * Every request is built from its shared contract (`contractRequest`), every
 * amount on the wire is milliunits, and the app-facing inputs stay in cents
 * (see `./api/base.ts`).
 */
import { transfersApi } from './api/transfers';

export type { BudgetScope } from './api/base';
export type { TransactionDetails } from './api/register';
export type {
  PayeeTransferRule,
  TransferLinkInput,
  TransferLinkResult,
  TransferRuleInput,
  TransferSuggestion,
} from './api/transfers';
export {
  targetsByCategoryFromRows,
  type BudgetMember,
  type BudgetMembersResponse,
  type CategoryNoteRow,
  type CategoryTargetPayload,
  type CategoryTargetRow,
  type PayeeSuggestionRow,
  type PayeeTxnRow,
} from './api/types';

/** The fully injected api: every endpoint of every area slice. */
export const budgetApi = transfersApi;

export const {
  useGetBudgetsQuery,
  useGetBudgetRevisionQuery,
  useRestoreBudgetMutation,
  useGetUsdBrlRateQuery,
  useGetGroupsQuery,
  useGetBundlesQuery,
  useGetCategoriesQuery,
  useCreateBundleMutation,
  useRenameBundleMutation,
  useDeleteBundleMutation,
  useSetCategoriesBundleMutation,
  useGetAccountsQuery,
  useGetTransactionsQuery,
  useGetTransactionDetailsQuery,
  useGetAssignmentsQuery,
  useGetMonthNotesQuery,
  useGetPayeesQuery,
  useGetCategoryTargetsQuery,
  useGetCategoryNotesQuery,
  useSetAssignedMutation,
  useApplyAssignmentUpdatesMutation,
  useApplyAutoAssignMutation,
  useAddTransactionMutation,
  useUpdateTransactionMutation,
  useDeleteTransactionMutation,
  useAddRepeatRuleMutation,
  useDeleteRepeatRuleMutation,
  useSetCategoryTargetMutation,
  useDeleteCategoryTargetMutation,
  useSetCategoryNotesMutation,
  useSetCategoryNoteMutation,
  useAddCategoryMutation,
  useRenameCategoryMutation,
  useDeleteCategoryMutation,
  useSetCategoryHiddenMutation,
  useSetCategoryPersonMutation,
  useSetGroupPersonMutation,
  useMoveCategoryMutation,
  useAddGroupMutation,
  useRenameGroupMutation,
  useDeleteGroupMutation,
  useAddPayeeMutation,
  useRenamePayeeMutation,
  useDeletePayeeMutation,
  useSetPayeeHiddenMutation,
  useSetPayeeCategorizationMutation,
  useMergePayeesMutation,
  useGetPayeeTransactionsQuery,
  useGetPayeeSuggestionQuery,
  useLazyGetPayeeSuggestionQuery,
  useSetPayeeRenameRuleMutation,
  useSetMonthNoteMutation,
  useCreateBudgetMutation,
  useRenameBudgetMutation,
  useArchiveBudgetMutation,
  useUnarchiveBudgetMutation,
  useDeleteBudgetMutation,
  useFreshStartBudgetMutation,
  useGetMeQuery,
  useGetBudgetMembersQuery,
  useAddBudgetMemberMutation,
  useRemoveBudgetMemberMutation,
  useLinkBudgetMemberEmailMutation,
  useRenameBudgetMemberMutation,
  useReconcileAccountMutation,
  useAddAccountMutation,
  useUpdateAccountMutation,
  useDeleteAccountMutation,
  useImportTransactionsMutation,
  useGetConnectionsQuery,
  useGetSyncStatusQuery,
  useLazyGetSyncStatusQuery,
  useGetConnectionQuery,
  useGetConnectionSummaryQuery,
  useGetConnectionTransactionsInfiniteQuery,
  useGetUpstreamAccountsQuery,
  useGetConnectionSettingsQuery,
  useUpdateSyncWindowMutation,
  useUpdateConnectionSyncWindowMutation,
  useCreateConnectionTokenMutation,
  useGetConnectionCredentialsQuery,
  useSaveConnectionCredentialsMutation,
  useDeleteConnectionCredentialsMutation,
  useRegisterConnectionMutation,
  useReimportHistoryMutation,
  useSyncConnectionMutation,
  useDisconnectConnectionMutation,
  useLinkAccountMutation,
  useGetTransferSuggestionsQuery,
  useLinkTransfersMutation,
  useUnlinkTransfersMutation,
  useMarkTransfersMutation,
  useGetPayeeTransferRuleQuery,
  useSetPayeeTransferRuleMutation,
} = budgetApi;
