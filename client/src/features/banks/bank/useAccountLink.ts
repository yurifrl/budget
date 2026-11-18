/**
 * Link / unlink one budget account to one upstream bank account. Both
 * return the user-facing error message (null on success) so each caller
 * decides where to surface it.
 *
 * `budgetId` is the active budget. A connection belongs to the user, not to a
 * budget, so an account it feeds may live in another budget: `unlink` and
 * `move` take that account's own budget, since the API scopes the account by
 * the budget in the request.
 */

import { useCallback } from 'react';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import { useLinkAccountMutation } from '@/budget/data/api';

export function useAccountLink(budgetId: string) {
  const [linkAccount, { isLoading }] = useLinkAccountMutation();

  const link = useCallback(
    async (accountId: string, connectionId: string, externalAccountId: string, institution: string | null, accountBudgetId: string = budgetId) => {
      try {
        await linkAccount({ budgetId: accountBudgetId, accountId, connectionId, externalAccountId, institution }).unwrap();
        return null;
      } catch (err) {
        return apiErrorMessage(err, 'failed to link account');
      }
    },
    [budgetId, linkAccount],
  );

  const unlink = useCallback(
    async (accountId: string, accountBudgetId: string = budgetId) => {
      try {
        await linkAccount({ budgetId: accountBudgetId, accountId, connectionId: null }).unwrap();
        return null;
      } catch (err) {
        return apiErrorMessage(err, 'failed to unlink account');
      }
    },
    [budgetId, linkAccount],
  );

  /**
   * Hand a bank account from one budget account to another. The server keeps
   * links strictly 1:1, so the old link is dropped first and restored if the
   * new one fails.
   */
  const move = useCallback(
    async (
      fromAccountId: string,
      toAccountId: string,
      connectionId: string,
      externalAccountId: string,
      institution: string | null,
      fromBudgetId: string = budgetId,
    ) => {
      const dropped = await unlink(fromAccountId, fromBudgetId);
      if (dropped) return dropped;
      const failure = await link(toAccountId, connectionId, externalAccountId, institution);
      if (!failure) return null;
      const restored = await link(fromAccountId, connectionId, externalAccountId, institution, fromBudgetId);
      return restored ? `${failure} (and the previous link could not be restored: ${restored})` : failure;
    },
    [budgetId, link, unlink],
  );

  return { link, unlink, move, busy: isLoading };
}
