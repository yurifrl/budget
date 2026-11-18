/**
 * budgetApi slice: Plan: groups, categories, bundles, assignments, targets and notes.
 * Injected into the one `budgetApi` (see ../api.ts); reducer path, tags and
 * cache behaviour are the slice's, unchanged by the split.
 */
import { contractRequest } from '@shared/contract-request';
import { assignmentsBatch, assignmentsList, assignmentsSet, bundlesCreate, bundlesDelete, bundlesList, bundlesRename, categoriesCreate, categoriesDelete, categoriesList, categoriesRename, categoriesReorder, categoriesSetBundle, categoriesSetGroupPerson, categoriesSetHidden, categoriesSetNotes, categoriesSetPerson, categoryNotesList, categoryNotesSet, categoryTargetsDelete, categoryTargetsList, categoryTargetsSet, groupsCreate, groupsDelete, groupsList, groupsRename, monthNotesList, monthNotesSet, planAutoAssign } from '@shared/contracts/budget';
import type { Cents, MonthKey } from '../../domain/types';
import type { AssignmentUpdate } from '../ledger';
import { centsToMilli, monthKeyToDate } from '../mapping';
import type { AssignmentRow, BundleRow, CategoryRow, GroupRow, MonthNoteRow } from '../rows';
import { type BudgetScope, scopedList } from './base';
import type { CategoryNoteRow, CategoryTargetPayload, CategoryTargetRow } from './types';
import { membersApi } from './members';

export const planApi = membersApi.injectEndpoints({
  endpoints: (b) => ({
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

    getAssignments: b.query<AssignmentRow[], BudgetScope>({
      query: scopedList(assignmentsList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Assignments', id: budgetId }],
    }),

    getMonthNotes: b.query<MonthNoteRow[], BudgetScope>({
      query: scopedList(monthNotesList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'MonthNotes', id: budgetId }],
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
          planApi.util.updateQueryData('getCategories', { budgetId }, (draft) => {
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
          planApi.util.updateQueryData('getCategories', { budgetId }, (draft) => {
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

    setMonthNote: b.mutation<null, BudgetScope & { month: MonthKey; note: string }>({
      query: ({ budgetId, month, note }) =>
        contractRequest(monthNotesSet, { budget_id: budgetId, month: monthKeyToDate(month), note }),
      invalidatesTags: (_r, _e, { budgetId }) => [{ type: 'MonthNotes', id: budgetId }],
    }),
  }),
});
