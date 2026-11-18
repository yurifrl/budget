/**
 * Link / unlink one budget account to one upstream bank account. Both
 * return the user-facing error message (null on success) so each caller
 * decides where to surface it.
 */

import { useCallback } from 'react';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import { useLinkAccountMutation } from '@/budget/data/api';

export function useAccountLink(budgetId: string) {
  const [linkAccount, { isLoading }] = useLinkAccountMutation();

  const link = useCallback(
    async (accountId: string, connectionId: string, externalAccountId: string, institution: string | null) => {
      try {
        await linkAccount({ budgetId, accountId, connectionId, externalAccountId, institution }).unwrap();
        return null;
      } catch (err) {
        return apiErrorMessage(err, 'failed to link account');
      }
    },
    [budgetId, linkAccount],
  );

  const unlink = useCallback(
    async (accountId: string) => {
      try {
        await linkAccount({ budgetId, accountId, connectionId: null }).unwrap();
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
    async (fromAccountId: string, toAccountId: string, connectionId: string, externalAccountId: string, institution: string | null) => {
      const dropped = await unlink(fromAccountId);
      if (dropped) return dropped;
      const failure = await link(toAccountId, connectionId, externalAccountId, institution);
      if (!failure) return null;
      const restored = await link(fromAccountId, connectionId, externalAccountId, institution);
      return restored ? `${failure} (and the previous link could not be restored: ${restored})` : failure;
    },
    [link, unlink],
  );

  return { link, unlink, move, busy: isLoading };
}
