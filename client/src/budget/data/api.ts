/**
 * budgetApi — RTK Query api for the Budget app over the local Hono API.
 *
 * Storage is the YNAB-v1-compatible schema (migration 0004): milliunits,
 * signed transaction amounts, payee_id references, the goal model, and
 * first-of-month date months. The wire carries MILLIUNITS for every amount,
 * both directions. This layer is the BOUNDARY — endpoints accept app-facing
 * input (cents, inflow/outflow, payee names, MonthKey) and convert to wire
 * milliunits on write; reads return raw rows that `mapping.ts` converts back to
 * the engine domain (or, for the few cents-shaped app types, a
 * `transformResponse` converts here).
 *
 * Budget-awareness: every read passes `?budget_id=…`, every insert sends
 * `budget_id`, and every cache tag is keyed by the budget id — so invalidation
 * never crosses budgets.
 *
 * Derived values (RTA / available / funding state) are never written — only
 * raw rows; the engine recomputes after each invalidation.
 */

import { createApi } from '@reduxjs/toolkit/query/react';
import type { z } from '@shared/zod';

import { apiBaseQuery, type ApiQuery } from '@/platform/api/baseQuery';
import { contractRequest } from '@/platform/api/contractRequest';
import {
  accountsCreate,
  accountsDelete,
  accountsReconcile,
  accountsUpdate,
  assignmentsBatch,
  assignmentsSet,
  budgetArchive,
  budgetCreate,
  budgetDelete,
  budgetFreshStart,
  budgetList,
  budgetRename,
  budgetRestore,
  budgetRevisionGet,
  budgetUnarchive,
  categoriesCreate,
  bundlesCreate,
  bundlesDelete,
  bundlesRename,
  categoriesSetBundle,
  categoriesDelete,
  categoriesRename,
  categoriesReorder,
  categoriesSetHidden,
  categoriesSetGroupPerson,
  categoriesSetNotes,
  categoriesSetPerson,
  categoryNotesList,
  categoryNotesSet,
  categoryTargetsDelete,
  categoryTargetsSet,
  groupsCreate,
  groupsDelete,
  groupsRename,
  membersAdd,
  membersLinkEmail,
  membersRename,
  membersList,
  membersRemove,
  monthNotesSet,
  payeeSuggestionGet,
  payeesCreate,
  payeesDelete,
  payeesMerge,
  payeesRename,
  payeesSetCategorization,
  payeesSetHidden,
  payeesSetRenameRule,
  payeesTransactions,
  planAutoAssign,
  repeatRulesCreate,
  repeatRulesDelete,
  transactionsBulk,
  transactionsCreate,
  transactionsDelete,
  transactionsUpdate,
  accountsList,
  assignmentsList,
  categoriesList,
  categoryTargetsList,
  bundlesList,
  groupsList,
  monthNotesList,
  payeesList,
  transactionsList,
} from '@shared/contracts/budget';
import { connectionsSummary, connectionsSyncStatus, connectionsTransactions } from '@shared/contracts/connections';

import type { CategorizationMode, MatchType } from '@shared/domain/payees';
import type { Person } from '../domain/people';
import type { CategoryTarget, Cents, MonthKey, RepeatFrequency } from '../domain/types';
import type { AssignmentUpdate } from './ledger';
import type {
  ConnectTokenJson,
  ConnectionJson,
  ConnectionSettingsJson,
  ConnectionSummaryJson,
  ConnectionTxnPageJson,
  ConnectionUpstreamJson,
  ConnectionsSyncResult,
  SyncStatusJson,
  ExternalAccountJson,
  ConnectionUpstreamWire,
  ExternalAccountWire,
} from './connections';
import { externalAccountFromWire, upstreamFromWire } from './connections';
import {
  centsToMilli,
  milliToCents,
  monthKeyToDate,
  restorePayloadToWire,
  snakeSubTxn,
  snakeTxn,
  snakeTxnPatch,
  type CentsRestorePayload,
  type ImportTxnWire,
  type SubTxnInput,
  type TransactionInput,
} from './mapping';
import type {
  AccountRow,
  AccountTypeRow,
  AssignmentRow,
  BudgetRow,
  BundleRow,
  CategoryRow,
  GroupRow,
  MonthNoteRow,
  PayeeAdminRow,
  PayeeRow,
  RepeatRuleRow,
  TransactionRow,
  UsdBrlRateRow,
} from './rows';

/** snakeSubTxn rows as the contract's `subtransactions` input; restore payload as its input minus budget_id. */
type SubWire = z.input<typeof transactionsCreate.input>['subtransactions'];
type RestoreWire = Omit<z.input<typeof budgetRestore.input>, 'budget_id'>;

/**
 * Engine-facing target payload for PUT /category-targets — mirrors
 * `CategoryTarget` in domain/types.ts (cents + camelCase config JSONB).
 */
export interface CategoryTargetPayload {
  kind: 'weekly' | 'monthly' | 'yearly' | 'custom';
  amountCents: Cents;
  /** MonthKey (YYYYMM) whose need the target skips (syscd-app-hsjm). */
  snoozeMonth?: number | null;
  config: Record<string, unknown>;
}

/** Row returned by GET /category-targets (wire shape, amount in milliunits). */
export interface CategoryTargetRow {
  budget_id: string;
  category_id: string;
  kind: 'weekly' | 'monthly' | 'yearly' | 'custom';
  amount: number;
  snooze_month: number | null;
  config: Record<string, unknown>;
}

/** Rows keyed by category (single definition — plan grid, move-money flow, auto-assign). */
export function targetsByCategoryFromRows(rows: readonly CategoryTargetRow[]): Map<string, CategoryTarget> {
  const map = new Map<string, CategoryTarget>();
  for (const row of rows) {
    map.set(row.category_id, {
      categoryId: row.category_id,
      kind: row.kind,
      amountCents: milliToCents(row.amount),
      snoozeMonth: row.snooze_month,
      config: row.config,
    });
  }
  return map;
}

/** One category's note for one month (category_notes table, syscd-app-nrg). */
export interface CategoryNoteRow {
  category_id: string;
  note: string;
}

/** GET /payee-suggestions/:id — what the payee's next transaction would be
 * categorized as (server infers per categorization mode + history). */
export interface PayeeSuggestionRow {
  payee_id: string;
  categorization_mode: CategorizationMode;
  category_id: string | null;
}

/** One row of GET /payees/:id/transactions (date DESC, signed milliunits). */
export interface PayeeTxnRow {
  id: string;
  date: string;
  amount: number;
  memo: string | null;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  account_id: string;
  account_name: string;
  category_id: string | null;
  category_name: string | null;
  payee_id: string;
}

/** Argument carried by every budget-scoped endpoint (also the cache-tag key). */
export interface BudgetScope {
  budgetId: string;
}

/** A person a budget is shared with (GET /budget-members). */
export type BudgetMember = Person;
export interface BudgetMembersResponse {
  members: BudgetMember[];
  can_manage: boolean;
}

/**
 * Member mutations return the fresh member list: write it straight into the
 * getBudgetMembers cache so the new/removed row appears with no refetch round
 * trip (a refetch would flash the list between the request and the reload).
 */
async function syncMembers(
  { budgetId }: { budgetId: string },
  { dispatch, queryFulfilled }: { dispatch: (a: never) => unknown; queryFulfilled: Promise<{ data: { members: BudgetMember[] } }> },
) {
  try {
    const { data } = await queryFulfilled;
    dispatch(
      budgetApi.util.updateQueryData('getBudgetMembers', { budgetId }, (draft) => {
        draft.members = data.members;
      }) as never,
    );
  } catch {
    /* the mutation's own error surfaces to the caller */
  }
}

/** Request builder for a budget-scoped list read: `{ budgetId }` -> `{ budget_id }`. */
function scopedList(contract: Parameters<typeof contractRequest>[0]) {
  return ({ budgetId }: BudgetScope): ApiQuery => contractRequest(contract, { budget_id: budgetId });
}

export const budgetApi = createApi({
  reducerPath: 'budgetApi',
  baseQuery: apiBaseQuery,
  // Writes from elsewhere (sync worker, webhooks, CLI/MCP, other devices) never
  // invalidate our tags: refetch active queries when the app regains focus or
  // connectivity (core/state/listeners wires focus/online for web AND native).
  refetchOnFocus: true,
  refetchOnReconnect: true,
  tagTypes: ['Budgets', 'Groups', 'Categories', 'Bundles', 'Accounts', 'Transactions', 'Assignments', 'MonthNotes', 'Payees', 'Targets', 'CategoryNotes', 'Connections', 'Members'],
  endpoints: (b) => ({
    // ------------------------------------------------------------------ reads
    getBudgets: b.query<BudgetRow[], void>({
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
      query: () => ({ url: '/rates/usd-brl' }),
      keepUnusedDataFor: 3600,
    }),

    getGroups: b.query<GroupRow[], BudgetScope>({
      query: scopedList(groupsList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Groups', id: budgetId }],
    }),

    getCategories: b.query<CategoryRow[], BudgetScope>({
      query: scopedList(categoriesList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Categories', id: budgetId }],
    }),

    getBundles: b.query<BundleRow[], BudgetScope>({
      query: scopedList(bundlesList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Bundles', id: budgetId }],
    }),

    getAccounts: b.query<AccountRow[], BudgetScope>({
      query: scopedList(accountsList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Accounts', id: budgetId }],
    }),

    getTransactions: b.query<TransactionRow[], BudgetScope>({
      query: scopedList(transactionsList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Transactions', id: budgetId }],
    }),

    getAssignments: b.query<AssignmentRow[], BudgetScope>({
      query: scopedList(assignmentsList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Assignments', id: budgetId }],
    }),

    getMonthNotes: b.query<MonthNoteRow[], BudgetScope>({
      query: scopedList(monthNotesList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'MonthNotes', id: budgetId }],
    }),

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

    /** Funding targets (category_targets table, syscd-app-nc5) keyed by category. */
    getCategoryTargets: b.query<CategoryTargetRow[], BudgetScope>({
      query: scopedList(categoryTargetsList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Targets', id: budgetId }],
    }),

    /** Per-category notes for one month (category_notes table, syscd-app-nrg). */
    getCategoryNotes: b.query<CategoryNoteRow[], BudgetScope & { month: MonthKey }>({
      query: ({ budgetId, month }) =>
        contractRequest(categoryNotesList, { budget_id: budgetId, month: monthKeyToDate(month) }),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'CategoryNotes', id: budgetId }],
    }),

    // -------------------------------------------------------------- mutations

    /** Inline-edit of one category's ASSIGNED for a month (absolute value, cents). */
    setAssigned: b.mutation<null, BudgetScope & { month: MonthKey; categoryId: string; assignedCents: Cents }>({
      query: ({ budgetId, month, categoryId, assignedCents }) =>
        contractRequest(assignmentsSet, {
          budget_id: budgetId,
          month: monthKeyToDate(month),
          category_id: categoryId,
          budgeted: centsToMilli(assignedCents),
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Assignments', id: budgetId }],
    }),

    /** Move money / cover overspend: absolute updates (cents) from ledger.moveMoneyUpdates. */
    applyAssignmentUpdates: b.mutation<null, BudgetScope & { month: MonthKey; updates: AssignmentUpdate[] }>({
      query: ({ budgetId, month, updates }) =>
        contractRequest(assignmentsBatch, {
          budget_id: budgetId,
          month: monthKeyToDate(month),
          updates: updates.map((u) => ({
            category_id: u.categoryId,
            budgeted: centsToMilli(u.assignedCents),
          })),
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Assignments', id: budgetId }],
    }),

    /** Auto-assign panel: persist one strategy's computed rows (absolute cents in, milliunits on the wire) for a month. */
    applyAutoAssign: b.mutation<null, BudgetScope & { month: MonthKey; rows: { categoryId: string; assignCents: Cents }[] }>({
      query: ({ budgetId, month, rows }) =>
        contractRequest(planAutoAssign, {
          budget_id: budgetId,
          month: monthKeyToDate(month),
          rows: rows.map((r) => ({ category_id: r.categoryId, assigned: centsToMilli(r.assignCents) })),
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Assignments', id: budgetId }],
    }),

    /** Insert a transaction (resolving its payee to a payee_id); the server derives the account balance deltas. */
    addTransaction: b.mutation<
      TransactionRow,
      BudgetScope & { txn: TransactionInput; subtransactions?: SubTxnInput[] }
    >({
      query: ({ budgetId, txn, subtransactions }) =>
        contractRequest(transactionsCreate, {
          budget_id: budgetId,
          txn: snakeTxn(txn) as z.input<typeof transactionsCreate.input>['txn'],
          subtransactions: subtransactions?.map(snakeSubTxn) as SubWire,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    /** Patch a transaction (edit / approve / categorize); the server re-derives account balances. */
    updateTransaction: b.mutation<
      null,
      BudgetScope & {
        id: string;
        patch: Partial<TransactionInput>;
        subtransactions?: SubTxnInput[];
      }
    >({
      query: ({ budgetId, id, patch, subtransactions }) =>
        contractRequest(transactionsUpdate, {
          id,
          budget_id: budgetId,
          patch: snakeTxnPatch(patch) as z.input<typeof transactionsUpdate.input>['patch'],
          subtransactions: subtransactions?.map(snakeSubTxn) as SubWire,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    /** Soft-delete a transaction; the server reverses its balance effect (syscd-app-42f row menu). */
    deleteTransaction: b.mutation<null, BudgetScope & { id: string }>({
      query: ({ budgetId, id }) => contractRequest(transactionsDelete, { id, budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
      ],
    }),

    /** Create a repeat rule; optionally attach the triggering draft txn and materialize due occurrences now. */
    addRepeatRule: b.mutation<
      RepeatRuleRow,
      BudgetScope & {
        accountId: string;
        payee: string;
        categoryId: string | null;
        memo: string | null;
        outflowCents: Cents;
        inflowCents: Cents;
        frequency: RepeatFrequency;
        monthLastDay: boolean;
        attachTransactionId: string | null;
      }
    >({
      query: ({ budgetId, accountId, payee, categoryId, memo, outflowCents, inflowCents, frequency, monthLastDay, attachTransactionId }) =>
        contractRequest(repeatRulesCreate, {
          budget_id: budgetId,
          account_id: accountId,
          payee,
          category_id: categoryId,
          memo,
          outflow: centsToMilli(outflowCents),
          inflow: centsToMilli(inflowCents),
          frequency,
          month_last_day: monthLastDay,
          attach_transaction_id: attachTransactionId,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    /** Delete a repeat rule: stops generation and soft-deletes pending upcoming instances. */
    deleteRepeatRule: b.mutation<null, BudgetScope & { ruleId: string }>({
      query: ({ budgetId, ruleId }) => contractRequest(repeatRulesDelete, { id: ruleId, budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
      ],
    }),

    /** Upsert one category's funding target (category_targets table, syscd-app-nc5). */
    setCategoryTarget: b.mutation<
      CategoryTargetRow,
      BudgetScope & { categoryId: string; target: CategoryTargetPayload }
    >({
      query: ({ budgetId, categoryId, target }) =>
        contractRequest(categoryTargetsSet, {
          categoryId,
          budget_id: budgetId,
          kind: target.kind,
          amount: centsToMilli(target.amountCents),
          snooze_month: target.snoozeMonth ?? null,
          config: target.config,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Targets', id: budgetId }],
    }),

    /** Clear one category's funding target. */
    deleteCategoryTarget: b.mutation<null, BudgetScope & { categoryId: string }>({
      query: ({ budgetId, categoryId }) => contractRequest(categoryTargetsDelete, { categoryId, budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Targets', id: budgetId }],
    }),

    /** Upsert one category's note for one month (syscd-app-nrg). */
    setCategoryNote: b.mutation<CategoryNoteRow, BudgetScope & { month: MonthKey; categoryId: string; note: string }>({
      query: ({ budgetId, month, categoryId, note }) =>
        contractRequest(categoryNotesSet, { categoryId, budget_id: budgetId, month: monthKeyToDate(month), note }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'CategoryNotes', id: budgetId }],
    }),

    setCategoryNotes: b.mutation<null, BudgetScope & { categoryId: string; notes: string }>({
      query: ({ categoryId, notes, budgetId }) =>
        contractRequest(categoriesSetNotes, { id: categoryId, budget_id: budgetId, notes }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Categories', id: budgetId }],
    }),

    addCategory: b.mutation<CategoryRow, BudgetScope & { groupId: string; name: string; sortOrder: number }>({
      query: ({ budgetId, groupId, name, sortOrder }) =>
        contractRequest(categoriesCreate, { budget_id: budgetId, group_id: groupId, name, sort_order: sortOrder }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Categories', id: budgetId }],
    }),

    renameCategory: b.mutation<null, BudgetScope & { categoryId: string; name: string }>({
      query: ({ categoryId, name, budgetId }) =>
        contractRequest(categoriesRename, { id: categoryId, budget_id: budgetId, name }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Categories', id: budgetId }],
    }),

    /** Tombstone a category (YNAB delta semantics); transactions/assignments keep their history. */
    deleteCategory: b.mutation<null, BudgetScope & { categoryId: string }>({
      query: ({ categoryId, budgetId }) => contractRequest(categoriesDelete, { id: categoryId, budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Categories', id: budgetId },
        { type: 'Bundles', id: budgetId },
        { type: 'Transactions', id: budgetId },
        { type: 'Assignments', id: budgetId },
      ],
    }),

    /**
     * Assign a category to a budget member (null = Shared). Optimistic: the
     * Categories cache flips immediately and rolls back if the server rejects.
     */
    setCategoryPerson: b.mutation<null, BudgetScope & { categoryId: string; userId: string | null }>({
      query: ({ categoryId, userId, budgetId }) =>
        contractRequest(categoriesSetPerson, { id: categoryId, budget_id: budgetId, user_id: userId }),
      onQueryStarted: async ({ budgetId, categoryId, userId }, { dispatch, queryFulfilled }) => {
        const patch = dispatch(
          budgetApi.util.updateQueryData('getCategories', { budgetId }, (draft) => {
            for (const c of draft) if (c.id === categoryId) c.user_id = userId;
          }) as never,
        ) as unknown as { undo: () => void };
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Categories', id: budgetId }],
    }),

    /** Assign every category of a group to one member (null = Shared) in one request. */
    setGroupPerson: b.mutation<null, BudgetScope & { groupId: string; userId: string | null }>({
      query: ({ groupId, userId, budgetId }) =>
        contractRequest(categoriesSetGroupPerson, { budget_id: budgetId, group_id: groupId, user_id: userId }),
      onQueryStarted: async ({ budgetId, groupId, userId }, { dispatch, queryFulfilled }) => {
        const patch = dispatch(
          budgetApi.util.updateQueryData('getCategories', { budgetId }, (draft) => {
            for (const c of draft) if (c.group_id === groupId) c.user_id = userId;
          }) as never,
        ) as unknown as { undo: () => void };
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Categories', id: budgetId }],
    }),

    /** Toggle a category's hidden flag (YNAB "hide category"). */
    setCategoryHidden: b.mutation<null, BudgetScope & { categoryId: string; hidden: boolean }>({
      query: ({ categoryId, hidden, budgetId }) =>
        contractRequest(categoriesSetHidden, { id: categoryId, budget_id: budgetId, hidden }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Categories', id: budgetId }],
    }),

    /** Bulk-reorder/move categories (plan-grid drag); body mirrors /reorder. */
    moveCategory: b.mutation<
      null,
      BudgetScope & { moves: { id: string; groupId: string; sortOrder: number }[] }
    >({
      query: ({ budgetId, moves }) =>
        contractRequest(categoriesReorder, {
          budget_id: budgetId,
          moves: moves.map((m) => ({ id: m.id, group_id: m.groupId, sort_order: m.sortOrder })),
        }),
      // Moving to another group can drop a category out of (and delete) a bundle.
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Categories', id: budgetId },
        { type: 'Bundles', id: budgetId },
      ],
    }),

    /** Bundle ≥ 2 categories into one group (categories of other groups are moved in). */
    createBundle: b.mutation<BundleRow, BudgetScope & { groupId: string; name: string; categoryIds: string[] }>({
      query: ({ budgetId, groupId, name, categoryIds }) =>
        contractRequest(bundlesCreate, { budget_id: budgetId, group_id: groupId, name, category_ids: categoryIds }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Bundles', id: budgetId },
        { type: 'Categories', id: budgetId },
      ],
    }),

    renameBundle: b.mutation<null, BudgetScope & { bundleId: string; name: string }>({
      query: ({ bundleId, name, budgetId }) => contractRequest(bundlesRename, { id: bundleId, budget_id: budgetId, name }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Bundles', id: budgetId }],
    }),

    /** Ungroup: deletes the bundle only; its categories stay. */
    deleteBundle: b.mutation<null, BudgetScope & { bundleId: string }>({
      query: ({ bundleId, budgetId }) => contractRequest(bundlesDelete, { id: bundleId, budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Bundles', id: budgetId },
        { type: 'Categories', id: budgetId },
      ],
    }),

    /** Put categories into a bundle (cross-group joins move them) or out of one (bundleId null). */
    setCategoriesBundle: b.mutation<null, BudgetScope & { categoryIds: string[]; bundleId: string | null }>({
      query: ({ categoryIds, bundleId, budgetId }) =>
        contractRequest(categoriesSetBundle, { budget_id: budgetId, category_ids: categoryIds, bundle_id: bundleId }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Bundles', id: budgetId },
        { type: 'Categories', id: budgetId },
      ],
    }),

    /** Create a category group inline from Plan. */
    addGroup: b.mutation<GroupRow, BudgetScope & { name: string; sortOrder?: number }>({
      query: ({ budgetId, name }) => contractRequest(groupsCreate, { budget_id: budgetId, name }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Groups', id: budgetId }],
    }),

    /** Rename a category group inline from Plan. */
    renameGroup: b.mutation<null, BudgetScope & { groupId: string; name: string }>({
      query: ({ groupId, name, budgetId }) => contractRequest(groupsRename, { id: groupId, budget_id: budgetId, name }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'Groups', id: budgetId }],
    }),

    /** Tombstone a category group; categories are tombstoned by the server. */
    deleteGroup: b.mutation<null, BudgetScope & { groupId: string }>({
      query: ({ groupId, budgetId }) => contractRequest(groupsDelete, { id: groupId, budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Groups', id: budgetId },
        { type: 'Categories', id: budgetId },
        { type: 'Bundles', id: budgetId },
      ],
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

    setMonthNote: b.mutation<null, BudgetScope & { month: MonthKey; note: string }>({
      query: ({ budgetId, month, note }) =>
        contractRequest(monthNotesSet, { budget_id: budgetId, month: monthKeyToDate(month), note }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'MonthNotes', id: budgetId }],
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

    /** People a budget is shared with (any member); `can_manage` = owner/admin. */
    getBudgetMembers: b.query<BudgetMembersResponse, { budgetId: string }>({
      query: ({ budgetId }) => contractRequest(membersList, { budget_id: budgetId }),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Members', id: budgetId }],
    }),

    /** Add a person: by email (idempotent) or, without one, a named placeholder (any member). */
    addBudgetMember: b.mutation<{ members: BudgetMember[] }, { budgetId: string; email?: string; name?: string }>({
      query: ({ budgetId, email, name }) => contractRequest(membersAdd, { budget_id: budgetId, email, name }),
      onQueryStarted: syncMembers,
    }),

    /** Attach an email to a placeholder; an existing user with that email absorbs it (merge). */
    linkBudgetMemberEmail: b.mutation<{ members: BudgetMember[] }, { budgetId: string; userId: string; email: string }>({
      query: ({ budgetId, userId, email }) => contractRequest(membersLinkEmail, { budget_id: budgetId, user_id: userId, email }),
      onQueryStarted: syncMembers,
      // A merge repoints the placeholder's accounts and categories at the surviving person.
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Accounts', id: budgetId },
        { type: 'Categories', id: budgetId },
      ],
    }),

    /** Rename a person who has not signed in (placeholder / invitee). */
    renameBudgetMember: b.mutation<{ members: BudgetMember[] }, { budgetId: string; userId: string; name: string }>({
      query: ({ budgetId, userId, name }) => contractRequest(membersRename, { budget_id: budgetId, user_id: userId, name }),
      onQueryStarted: syncMembers,
    }),

    /** Stop sharing with a member (owner/admin; the owner cannot be removed). */
    removeBudgetMember: b.mutation<{ members: BudgetMember[] }, { budgetId: string; userId: string }>({
      query: ({ budgetId, userId }) => contractRequest(membersRemove, { budget_id: budgetId, user_id: userId }),
      // Removal also nulls that person's accounts and categories server-side.
      onQueryStarted: syncMembers,
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Accounts', id: budgetId },
        { type: 'Categories', id: budgetId },
      ],
    }),

    /** Signed-in user (Account Settings sub-view — email display only). */
    getMe: b.query<{ email: string; role: string }, void>({
      query: () => ({ url: '/auth/me' }),
    }),

    /**
     * Create an account (name + YNAB type). A non-zero opening balance is
     * booked server-side as a "Starting Balance" transaction carrying the
     * amount (debt types start negative, at the amount owed).
     */
    addAccount: b.mutation<
      AccountRow,
      BudgetScope & {
        name: string;
        type: AccountTypeRow;
        onBudget?: boolean;
        balanceCents: Cents;
        /** Person (budget member) owning the account; omit/null = Shared. */
        userId?: string | null;
      }
    >({
      query: ({ budgetId, name, type, onBudget, balanceCents, userId }) =>
        contractRequest(accountsCreate, {
          budget_id: budgetId,
          name,
          type,
          on_budget: onBudget ?? true,
          balance: centsToMilli(balanceCents),
          ...(userId ? { user_id: userId } : {}),
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    /**
     * Edit account fields. `workingBalanceCents` SETS the balance directly —
     * an override, not a ledger operation (no adjustment entry is booked);
     * `closed` toggles the CLOSED group per the 0004 sync invariant.
     */
    updateAccount: b.mutation<
      AccountRow,
      BudgetScope & {
        accountId: string;
        name?: string;
        note?: string | null;
        closed?: boolean;
        workingBalanceCents?: Cents;
        /** Person owning the account; null = Shared, omit = unchanged. */
        userId?: string | null;
      }
    >({
      query: ({ budgetId, accountId, name, note, closed, workingBalanceCents, userId }) =>
        contractRequest(accountsUpdate, {
          id: accountId,
          budget_id: budgetId,
          name,
          note,
          closed,
          working_balance: workingBalanceCents === undefined ? undefined : centsToMilli(workingBalanceCents),
          user_id: userId,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Accounts', id: budgetId },
        { type: 'Transactions', id: budgetId },
      ],
    }),

    /**
     * Delete a closed account with every transaction it ever held. The
     * server moves balances itself (reverse of each deleted row) — no client
     * delta contract like deleteTransaction.
     */
    deleteAccount: b.mutation<null, BudgetScope & { accountId: string }>({
      query: ({ budgetId, accountId }) => contractRequest(accountsDelete, { id: accountId, budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Accounts', id: budgetId },
        { type: 'Transactions', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    /**
     * Reconcile: set the account's working balance to the stated value
     * (booking an adjustment transaction for any difference, uncategorized so
     * it lands in Ready-to-Assign) and lock every transaction as reconciled.
     * `reconcileAll` is YNAB's "Yes" shortcut: the on-screen balance already
     * matches the bank, so every row — pending included — locks as reconciled
     * with no adjustment booked.
     */
    reconcileAccount: b.mutation<
      null,
      BudgetScope & { accountId: string; statedBalanceCents: Cents; reconcileAll?: boolean }
    >({
      query: ({ budgetId, accountId, statedBalanceCents, reconcileAll }) =>
        contractRequest(accountsReconcile, {
          id: accountId,
          budget_id: budgetId,
          stated_balance: centsToMilli(statedBalanceCents),
          ...(reconcileAll ? { reconcile_all: true } : {}),
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
      ],
    }),

    /**
     * Statement import: one batch of parsed rows into one account. The server
     * resolves payees (rename rules + upsert), dedupes on import_id, computes
     * the account balance delta itself, and stores rows uncleared/unapproved.
     */
    importTransactions: b.mutation<
      { imported: number; duplicates: number },
      BudgetScope & { accountId: string; txns: ImportTxnWire[] }
    >({
      query: ({ budgetId, accountId, txns }) =>
        contractRequest(transactionsBulk, { budget_id: budgetId, account_id: accountId, txns }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    // ------------------------------------------------------------- connections
    // Bank linking: connections are user-scoped (not budget-scoped) rows; the
    // budget link itself is a property of the account row (PATCH /accounts/:id
    // with a `link` body), never a separate ledger entity.

    /** List the user's connections with their statuses (drives re-auth CTAs). */
    getConnections: b.query<ConnectionJson[], void>({
      query: () => ({ url: '/connections' }),
      providesTags: ['Connections'],
    }),

    /** One connection's status — cross-user ids surface as 404. */
    getConnection: b.query<ConnectionJson, { id: string }>({
      query: ({ id }) => ({ url: `/connections/${id}` }),
      providesTags: (_r, _e, { id }) => [{ type: 'Connections', id }],
    }),

    /**
     * Widget credentials for the connect WebView. `itemId` re-auths an
     * existing item instead of creating a duplicate upstream connection.
     */
    createConnectionToken: b.mutation<
      ConnectTokenJson,
      { provider: string; connectorId?: number; itemId?: string }
    >({
      query: ({ provider, connectorId, itemId }) => ({
        url: '/connections/connect-token',
        method: 'POST',
        body: {
          provider,
          ...(connectorId != null ? { connectorId } : {}),
          ...(itemId != null ? { itemId } : {}),
        },
      }),
    }),

    /**
     * Register a completed widget item: stores the connection and returns its
     * upstream accounts for the caller to pick the one being linked.
     */
    registerConnection: b.mutation<
      { connection: ConnectionJson; accounts: ExternalAccountJson[] },
      { provider: string; itemId: string }
    >({
      query: ({ provider, itemId }) => ({
        url: '/connections/items',
        method: 'POST',
        body: { provider, itemId },
      }),
      transformResponse: (wire: { connection: ConnectionJson; accounts: ExternalAccountWire[] }) => ({
        connection: wire.connection,
        accounts: wire.accounts.map((a) => externalAccountFromWire(a)),
      }),
      invalidatesTags: ['Connections'],
    }),

    /** Per-account import counts + totals for one connection (bank page Overview). */
    getConnectionSummary: b.query<ConnectionSummaryJson, { id: string }>({
      query: ({ id }) => contractRequest(connectionsSummary, { id }),
      providesTags: (_r, _e, { id }) => [{ type: 'Connections', id }],
    }),

    /**
     * One linked account's bank-imported transactions, newest first. Infinite
     * query over the server's keyset cursor: pages load only on demand (pass
     * skipToken until the tab is first opened, then `fetchNextPage`).
     */
    getConnectionTransactions: b.infiniteQuery<
      ConnectionTxnPageJson,
      { id: string; accountId: string },
      string | null
    >({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (last) => last?.nextCursor ?? undefined,
      },
      query: ({ queryArg, pageParam }) =>
        contractRequest(connectionsTransactions, {
          id: queryArg.id,
          accountId: queryArg.accountId,
          limit: 50,
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      providesTags: (_r, _e, { id }) => [{ type: 'Connections', id }],
    }),

    /**
     * Per-connection sync state (status pill, active/last run) + scheduler
     * health. Polled by screens while a run is active; never cached long.
     */
    getSyncStatus: b.query<SyncStatusJson, void>({
      query: () => contractRequest(connectionsSyncStatus, {}),
      providesTags: ['Connections'],
    }),

    /**
     * Request a background sync. Returns the queued/running run immediately
     * (joins one already in flight); callers poll `getSyncStatus` for the
     * outcome and invalidate data tags when it lands (see useSyncRunner).
     */
    syncConnection: b.mutation<ConnectionsSyncResult, { id: string; budgetId: string }>({
      query: ({ id }) => ({ url: `/connections/${id}/sync`, method: 'POST' }),
      invalidatesTags: ['Connections'],
    }),

    /** Request a background re-import: watermark-ignoring pull over the full window (deduped). */
    reimportHistory: b.mutation<ConnectionsSyncResult, { id: string; budgetId: string }>({
      query: ({ id }) => ({ url: `/connections/${id}/reimport`, method: 'POST' }),
      invalidatesTags: ['Connections'],
    }),

    /** Disconnect: remove upstream and flip the row out of the poller's reach. */
    disconnectConnection: b.mutation<{ ok: boolean }, { id: string; budgetId: string }>({
      query: ({ id }) => ({ url: `/connections/${id}`, method: 'DELETE' }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        'Connections',
        { type: 'Accounts', id: budgetId },
      ],
    }),

    /**
     * Every live connection's upstream accounts with their 1:1 link state —
     * the bank-link chooser's single data pull.
     */
    getUpstreamAccounts: b.query<ConnectionUpstreamJson[], void>({
      query: () => ({ url: '/connections/upstream' }),
      transformResponse: (wire: ConnectionUpstreamWire[]) => upstreamFromWire(wire),
      providesTags: ['Connections'],
    }),

    /** App-global sync-window config (how far back pulls reach; 0 = all). */
    getConnectionSettings: b.query<ConnectionSettingsJson, void>({
      query: () => ({ url: '/connections/settings' }),
      providesTags: ['Connections'],
    }),

    /** Change the sync window. Rejects out-of-bounds days (server-validated). */
    updateSyncWindow: b.mutation<ConnectionSettingsJson, { syncWindowDays: number }>({
      query: (body) => ({ url: '/connections/settings', method: 'PATCH', body }),
      invalidatesTags: ['Connections'],
    }),

    /** Per-bank sync window (days; 0 = all history; null = inherit the app default). */
    updateConnectionSyncWindow: b.mutation<ConnectionJson, { id: string; syncWindowDays: number | null }>({
      query: ({ id, syncWindowDays }) => ({ url: `/connections/${id}/settings`, method: 'PATCH', body: { syncWindowDays } }),
      invalidatesTags: ['Connections'],
    }),

    /**
     * Link / unlink an account to a connection's upstream account. Null
     * `connectionId` unlinks; linking requires `externalAccountId`.
     */
    linkAccount: b.mutation<
      AccountRow,
      BudgetScope & {
        accountId: string;
        connectionId: string | null;
        externalAccountId?: string;
        institution?: string | null;
      }
    >({
      query: ({ budgetId, accountId, connectionId, externalAccountId, institution }) =>
        contractRequest(accountsUpdate, {
          id: accountId,
          budget_id: budgetId,
          // Unlink is an object with a null connectionId — the contract validates
          // `link` as an optional object, so a bare null would be rejected.
          link: {
            connectionId,
            externalAccountId: externalAccountId ?? null,
            ...(institution !== undefined ? { institution } : {}),
          },
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Accounts', id: budgetId },
        'Connections',
      ],
    }),

    /**
     * Full budget restore from a transfer payload (backup import). Replaces
     * the budget-scoped data: groups, categories, accounts, payees,
     * transactions, assignments. Returns the counts written per table.
     */
    restoreBudget: b.mutation<
      {
        groups: number;
        categories: number;
        accounts: number;
        transactions: number;
        assignments: number;
      },
      // The transfer payload (transfer/payload.ts) is domain cents; sent as a format-2 (milliunit) document.
      { budgetId: string; payload: CentsRestorePayload }
    >({
      query: ({ budgetId, payload }) =>
        contractRequest(budgetRestore, { budget_id: budgetId, ...(restorePayloadToWire(payload) as RestoreWire) }),
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
  }),
});

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
  useRegisterConnectionMutation,
  useReimportHistoryMutation,
  useSyncConnectionMutation,
  useDisconnectConnectionMutation,
  useLinkAccountMutation,
} = budgetApi;
