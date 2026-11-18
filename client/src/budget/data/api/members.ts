/**
 * budgetApi slice: People a budget is shared with.
 * Injected into the one `budgetApi` (see ../api.ts); reducer path, tags and
 * cache behaviour are the slice's, unchanged by the split.
 */
import { contractRequest } from '@shared/contract-request';
import { membersAdd, membersLinkEmail, membersList, membersRemove, membersRename } from '@shared/contracts/budget';
import type { BudgetMember, BudgetMembersResponse } from './types';
import { budgetsApi } from './budgets';

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
      membersApi.util.updateQueryData('getBudgetMembers', { budgetId }, (draft) => {
        draft.members = data.members;
      }) as never,
    );
  } catch {
    /* the mutation's own error surfaces to the caller */
  }
}

export const membersApi = budgetsApi.injectEndpoints({
  endpoints: (b) => ({
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
  }),
});
