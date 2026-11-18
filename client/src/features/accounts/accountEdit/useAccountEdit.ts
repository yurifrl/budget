/**
 * State and actions of the Edit Account modal: the form drafts, the confirm
 * dialogs, the bank-link lookups and every mutation. Returns null while no
 * account is open (all hooks still run, in a fixed order).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import {
  useGetAccountsQuery,
  useGetConnectionsQuery,
  useGetUpstreamAccountsQuery,
  useUpdateAccountMutation,
  useDeleteAccountMutation,
} from '@/budget/data/api';
import type { AccountRow } from '@/budget/data/rows';
import { accountSavePatch, balanceEdit, closeAccountPatch } from '@/domain/accountEdit';
import { connectionStatusView , upstreamOption , useAccountLink , useSyncRunner } from '@/features/banks';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { findLinkedUpstream, workingCents } from './accountEdit.logic';

export type AccountEdit = NonNullable<ReturnType<typeof useAccountEdit>>;

export function useAccountEdit(account: AccountRow | null, budgetId: string, onClose: () => void) {
  const { formatMoney, parseMoney } = useMoneyFormat();
  const [updateAccount, { isLoading }] = useUpdateAccountMutation();
  const syncRunner = useSyncRunner(budgetId);
  const [syncing, setSyncing] = useState(false);
  const accountLink = useAccountLink(budgetId);
  const budgetAccounts = useGetAccountsQuery({ budgetId }).data ?? [];
  const [deleteAccount, { isLoading: deleting }] = useDeleteAccountMutation();
  const router = useRouter();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  // Draft of the working-balance line, kept as a display string until commit.
  const [balanceDraft, setBalanceDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // YNAB's Close Account confirm: null = closed dialog, otherwise the working
  // balance being zeroed out (0 = the plain "are you sure" variant).
  const [closeAsk, setCloseAsk] = useState<{ amount: number } | null>(null);
  // Destructive delete confirm (closed accounts only): account + every
  // transaction it ever held, gone from the budget.
  const [deleteAsk, setDeleteAsk] = useState(false);
  // Unlink confirm (explains what stays and what stops).
  const [unlinkAsk, setUnlinkAsk] = useState(false);
  // Sub-modal that picks which bank account this account follows (first link
  // or "Change link"); keeps Edit Account compact.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Reset the form whenever a (different) account opens.
  useEffect(() => {
    if (!account) return;
    setName(account.name);
    setNote(account.note ?? '');
    setUserId(account.user_id);
    setBalanceDraft(null);
    setError(null);
    setCloseAsk(null);
    setUnlinkAsk(false);
    setPickerOpen(false);
  }, [account]);

  // Fetch before the early return (rules of hooks); lookup is account-scoped.
  const connections = useGetConnectionsQuery();
  // Linked accounts read their upstream row from this aggregate; unlinked
  // ones pick from it (1:1 links already taken are filtered out of the
  // chooser).
  const upstream = useGetUpstreamAccountsQuery(undefined);

  if (!account) return null;

  const connection =
    connections.data?.find((c) => c.id === account.connection_id) ?? null;
  const status = connection
    ? connectionStatusView(connection.status)
    : null;
  // The upstream account currently backing this budget account (1:1).
  const linked = findLinkedUpstream(upstream.data ?? [], account.id);
  const linkedOption = linked
    ? upstreamOption(
        linked.entry.connection.id,
        linked.entry.connection.institution ?? linked.entry.connection.provider,
        linked.account,
        account,
        budgetAccounts,
      )
    : null;

  const syncNow = async () => {
    if (!connection) return;
    setError(null);
    setSyncing(true);
    try {
      // Background run: waits for it, and a failure shows its user-safe message.
      const outcome = await syncRunner.run(connection.id, 'sync');
      if (outcome.kind === 'error') setError(outcome.text);
    } catch (err) {
      setError(apiErrorMessage(err, 'sync failed'));
    } finally {
      setSyncing(false);
    }
  };

  const reconnect = () => {
    if (!connection) return;
    router.push(
      `/connect-bank?itemId=${connection.external_id}&connectionId=${connection.id}`,
    );
  };

  /** Sever only this account's bank link — the bank itself is removed on the connect-bank page. */
  const unlink = async () => {
    setError(null);
    const failure = await accountLink.unlink(account.id, budgetId);
    setUnlinkAsk(false);
    if (failure) setError(failure);
  };

  const manageOnBankPage = () => {
    if (!connection) return;
    onClose();
    router.push(`/connection?id=${connection.id}` as never);
  };

  const working = workingCents(account);
  const balance = balanceEdit(balanceDraft, working, { formatMoney, parseMoney });

  const save = async (closed?: boolean) => {
    const result = accountSavePatch({ name, note, userId, savedUserId: account.user_id, closed, balance });
    if ('error' in result) {
      setError(result.error);
      return;
    }
    try {
      await updateAccount({ budgetId, accountId: account.id, ...result.patch }).unwrap();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to update account'));
    }
  };

  // YNAB close flow (closeAccountPatch). A typed balance draft is
  // intentionally ignored: close zeroes the account's real working balance.
  const closeAccount = async () => {
    setCloseAsk(null);
    setError(null);
    try {
      await updateAccount({ budgetId, accountId: account.id, ...closeAccountPatch(working) }).unwrap();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to close account'));
    }
  };

  // Delete flow: soft-deletes the closed account and every transaction it
  // ever held server-side (balances move with the rows — no client deltas).
  const deleteAccountForever = async () => {
    setDeleteAsk(false);
    setError(null);
    try {
      await deleteAccount({ budgetId, accountId: account.id }).unwrap();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to delete account'));
    }
  };

  return {
    account,
    isLoading,
    deleting,
    error,
    name,
    setName,
    note,
    setNote,
    userId,
    setUserId,
    working,
    balance,
    setBalanceDraft,
    save,
    closeAsk,
    setCloseAsk,
    closeAccount,
    deleteAsk,
    setDeleteAsk,
    deleteAccountForever,
    connection,
    status,
    upstream,
    linkedOption,
    budgetAccounts,
    syncing,
    syncNow,
    reconnect,
    manageOnBankPage,
    connectNewBank: () => router.push('/connect-bank' as never),
    pickerOpen,
    setPickerOpen,
    unlinkAsk,
    setUnlinkAsk,
    unlink,
    linkBusy: accountLink.busy,
  };
}
