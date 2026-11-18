/**
 * Edit Account modal — YNAB parity (right-click an account in the rail).
 *
 * "Account Information" (nickname + notes), a "Working Balance" editor that
 * SETS the balance directly (an override — no ledger entry is created; the
 * /reconcile flow is the ledger-preserving counterpart), and a Close Account
 * action in the footer.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import {
  useGetAccountsQuery,
  useGetConnectionsQuery,
  useGetUpstreamAccountsQuery,
  useUpdateAccountMutation,
  useDeleteAccountMutation,
} from '../data/api';
import { AccountRow } from '../data/rows';
import { milliToCents } from '../data/mapping';
import { connectionStatusView, requiresReauth } from '../domain/connections';
import { useMoneyFormat } from '../model/useDisplayPrefs';
import { upstreamOption } from '../domain/linkPicker';
import { KeyboardModalFrame } from '../ui/KeyboardModalFrame';
import { LinkedBy } from '../ui/LinkedBy';
import { colors } from '../ui/theme';
import { PersonPicker } from './PersonPicker';
import { LinkOptionCard } from './bank/LinkOptionCard';
import { UpstreamPickerSheet } from './bank/LinkSheets';
import { UnlinkConfirm } from './bank/UnlinkConfirm';
import { useAccountLink } from './bank/useAccountLink';
import { useSyncRunner } from './connect-bank/useSyncRunner';

export function AccountEditModal({
  account,
  budgetId,
  onClose,
}: {
  account: AccountRow | null;
  budgetId: string;
  onClose: () => void;
}) {
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
  const linkedUpstream =
    (upstream.data ?? []).flatMap((entry) => entry.accounts ?? []).find((a) => a.linkedAccountId === account.id) ??
    null;
  const linkedEntry = linkedUpstream
    ? (upstream.data ?? []).find((entry) => entry.accounts?.includes(linkedUpstream)) ?? null
    : null;
  const linkedOption =
    linkedUpstream && linkedEntry
      ? upstreamOption(
          linkedEntry.connection.id,
          linkedEntry.connection.institution ?? linkedEntry.connection.provider,
          linkedUpstream,
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
    const failure = await accountLink.unlink(account.id);
    setUnlinkAsk(false);
    if (failure) setError(failure);
  };

  const manageOnBankPage = () => {
    if (!connection) return;
    onClose();
    router.push(`/connection?id=${connection.id}` as never);
  };

  const working = milliToCents(account.cleared_balance + account.uncleared_balance);
  const balanceText = balanceDraft ?? formatMoney(working);
  const balanceCents = parseMoney(balanceText);
  const balanceChanged = balanceCents !== working;

  const save = async (closed?: boolean) => {
    if (!name.trim()) {
      setError('nickname is required');
      return;
    }
    try {
      await updateAccount({
        budgetId,
        accountId: account.id,
        name: name.trim(),
        note: note.trim() || null,
        ...(userId !== account.user_id ? { userId } : {}),
        ...(closed !== undefined ? { closed } : {}),
        ...(balanceChanged ? { workingBalanceCents: balanceCents } : {}),
      }).unwrap();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to update account'));
    }
  };

  // YNAB close flow: zero the balance out and flip closed in one save — the
  // working_balance_cents: 0 edit books the adjustment transaction server-side
  // (same mechanic as reconciliation). A typed balance draft is intentionally
  // ignored: close zeroes the account's real working balance.
  const closeAccount = async () => {
    setCloseAsk(null);
    setError(null);
    try {
      await updateAccount({
        budgetId,
        accountId: account.id,
        ...(working !== 0 ? { workingBalanceCents: 0 } : {}),
        closed: true,
      }).unwrap();
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

  return (
    <Modal visible={account != null} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardModalFrame onBackdropPress={onClose} cardStyle={styles.modal}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.title}>Edit Account</Text>
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          {account.closed ? (
            <Text style={styles.closedBanner}>
              This account is closed — its details are read-only. Reopen it to make changes.
            </Text>
          ) : null}

          <Text style={styles.section}>ACCOUNT INFORMATION</Text>
          <Text style={styles.label}>Account Nickname</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Account nickname"
            placeholderTextColor={colors.faint}
            editable={!isLoading && !account.closed}
          />
          <Text style={styles.label}>Account Notes</Text>
          <TextInput
            style={[styles.input, styles.notes]}
            value={note}
            onChangeText={setNote}
            placeholder="Notes"
            placeholderTextColor={colors.faint}
            multiline
            editable={!isLoading && !account.closed}
          />

          <Text style={styles.label}>Person</Text>
          <PersonPicker
            budgetId={budgetId}
            value={userId}
            onChange={setUserId}
            disabled={isLoading || account.closed}
          />

          <View style={styles.divider} />

          <Text style={styles.label}>Working Balance</Text>
          <TextInput
            style={styles.input}
            value={balanceText}
            onChangeText={(t) => setBalanceDraft(t)}
            editable={!isLoading && !account.closed}
            inputMode="decimal"
          />
          {balanceChanged ? (
            <Text style={styles.hint}>
              Sets the balance directly — an override, not a ledger entry.
            </Text>
          ) : null}

          <View style={styles.divider} />

          <Text style={styles.section}>BANK CONNECTION</Text>
          {connection && status ? (
            <View style={styles.connBox}>
              <View style={styles.connRow}>
                <Text style={styles.connGlyph}>🏦</Text>
                <Text style={styles.connName} numberOfLines={1}>
                  {`Connected to ${account.institution ?? connection.institution ?? 'bank'}`}
                </Text>
                <Text style={[styles.connStatus, { color: STATUS_COLOR[status.tone] }]}>{status.label}</Text>
              </View>
              <LinkedBy linkedBy={account.linked_by ?? connection.linked_by} />
              <View style={styles.linkedCard}>
                {upstream.isLoading ? (
                  <ActivityIndicator size="small" color={colors.indigo2} />
                ) : linkedOption ? (
                  <>
                    <Text style={styles.followLabel}>FOLLOWING</Text>
                    <LinkOptionCard option={linkedOption} />
                  </>
                ) : (
                  <Text style={styles.hint}>
                    {upstream.data?.some((entry) => entry.accounts == null)
                      ? 'Bank account list unavailable — Sync now to refresh.'
                      : 'This link no longer matches a bank account — change the link to pick a new one.'}
                  </Text>
                )}
              </View>
              <View style={styles.connActions}>
                <Pressable style={styles.connBtn} disabled={syncing} onPress={() => void syncNow()}>
                  <Text style={styles.ghostText}>{syncing ? 'Syncing…' : 'Sync now'}</Text>
                </Pressable>
                {requiresReauth(connection.status) ? (
                  <Pressable style={styles.warnBtn} onPress={reconnect}>
                    <Text style={styles.warnText}>Reconnect</Text>
                  </Pressable>
                ) : null}
                <Pressable style={styles.connBtn} accessibilityRole="button" onPress={manageOnBankPage}>
                  <Text style={styles.ghostText}>Manage on bank page</Text>
                </Pressable>
                <Pressable style={styles.connBtn} onPress={() => setPickerOpen(true)}>
                  <Text style={styles.ghostText}>Change link</Text>
                </Pressable>
                <Pressable style={styles.connBtn} disabled={accountLink.busy} onPress={() => setUnlinkAsk(true)}>
                  <Text style={styles.unlinkText}>Unlink</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.linkBox}>
              <Text style={styles.hint}>
                Not linked to a bank. Connect one to import transactions and update the balance automatically.
              </Text>
              <Pressable
                style={styles.chooseBtn}
                accessibilityRole="button"
                accessibilityLabel="Choose bank account"
                onPress={() => setPickerOpen(true)}>
                <Text style={styles.chooseBtnText}>Choose bank account</Text>
              </Pressable>
              <Pressable
                style={styles.linkBtn}
                accessibilityRole="button"
                accessibilityLabel="Connect a new bank"
                onPress={() => router.push('/connect-bank' as never)}>
                <Text style={styles.linkBtnText}>Connect a new bank</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.divider} />

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.footer}>
            {account.closed ? (
              <>
                <Pressable style={styles.closeAccountBtn} disabled={isLoading} onPress={() => void save(false)}>
                  <Text style={styles.closeAccountText}>Re-open</Text>
                </Pressable>
                <Pressable style={styles.deleteBtn} disabled={deleting || isLoading} onPress={() => setDeleteAsk(true)}>
                  <Text style={styles.deleteText}>{deleting ? 'Deleting…' : 'Delete'}</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                style={styles.closeAccountBtn}
                disabled={isLoading}
                onPress={() => setCloseAsk({ amount: working })}>
                <Text style={styles.closeAccountText}>Close Account</Text>
              </Pressable>
            )}
            <View style={styles.footerRight}>
              <Pressable style={styles.ghostBtn} disabled={isLoading} onPress={onClose}>
                <Text style={styles.ghostText}>Cancel</Text>
              </Pressable>
              {account.closed ? null : (
                <Pressable style={styles.indigoBtn} disabled={isLoading} onPress={() => void save()}>
                  <Text style={styles.indigoText}>Save</Text>
                </Pressable>
              )}
            </View>
          </View>
        </ScrollView>

        {closeAsk ? (
          <Pressable style={styles.confirmScrim} onPress={(e) => e.stopPropagation()}>
            <View style={styles.confirmBox}>
              <Text style={styles.confirmTitle}>Close Account</Text>
              {closeAsk.amount === 0 ? (
                <>
                  <Text style={styles.confirmBody}>
                    Are you sure you want to close this account?
                  </Text>
                  <View style={styles.confirmFooter}>
                    <Pressable style={styles.ghostBtn} onPress={() => setCloseAsk(null)}>
                      <Text style={styles.ghostText}>Cancel</Text>
                    </Pressable>
                    <Pressable style={styles.closeAccountBtn} disabled={isLoading} onPress={() => void closeAccount()}>
                      <Text style={styles.closeAccountText}>Close</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.confirmBody}>
                    Before you can close this account, the balance will have to be zeroed
                    out. An adjustment transaction will be created for{' '}
                    <Text style={styles.confirmBodyStrong}>
                      {formatMoney(Math.abs(closeAsk.amount))}
                    </Text>
                    .
                  </Text>
                  {account.on_budget && closeAsk.amount > 0 ? (
                    <Text style={styles.helpbox}>
                      The money in this account will be removed from your plan. If you
                      would like to keep it in your plan, you can transfer it to another
                      account before closing this one.
                    </Text>
                  ) : null}
                  <View style={styles.confirmFooter}>
                    <Pressable style={styles.ghostBtn} onPress={() => setCloseAsk(null)}>
                      <Text style={styles.ghostText}>Cancel</Text>
                    </Pressable>
                    <Pressable style={styles.indigoBtn} disabled={isLoading} onPress={() => void closeAccount()}>
                      <Text style={styles.indigoText}>Adjust Balance &amp; Close</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          </Pressable>
        ) : null}

        {unlinkAsk ? (
          <Pressable style={styles.confirmScrim} onPress={(e) => e.stopPropagation()}>
            <View style={styles.confirmBox}>
              <UnlinkConfirm
                accountName={account.name}
                busy={accountLink.busy}
                onCancel={() => setUnlinkAsk(false)}
                onConfirm={() => void unlink()}
              />
            </View>
          </Pressable>
        ) : null}

        {deleteAsk ? (
          <Pressable style={styles.confirmScrim} onPress={(e) => e.stopPropagation()}>
            <View style={styles.confirmBox}>
              <Text style={styles.confirmTitle}>Delete Account</Text>
              <Text style={styles.confirmBody}>
                Permanently delete <Text style={styles.confirmBodyStrong}>{account.name}</Text> and
                every transaction it ever held? The account&apos;s balance will be removed from
                your plan. This cannot be undone.
              </Text>
              <View style={styles.confirmFooter}>
                <Pressable style={styles.ghostBtn} disabled={deleting} onPress={() => setDeleteAsk(false)}>
                  <Text style={styles.ghostText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.deleteBtn} disabled={deleting} onPress={() => void deleteAccountForever()}>
                  <Text style={styles.deleteText}>{deleting ? 'Deleting…' : 'Delete'}</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        ) : null}

        <UpstreamPickerSheet
          budgetId={budgetId}
          account={account}
          budgetAccounts={budgetAccounts}
          upstream={upstream.data ?? []}
          loading={upstream.isLoading}
          loadFailed={upstream.isError}
          onRetry={() => void upstream.refetch()}
          visible={pickerOpen}
          onClose={() => setPickerOpen(false)}
        />
      </KeyboardModalFrame>
    </Modal>
  );
}

const STATUS_COLOR = {
  ok: colors.green,
  warn: colors.yellow,
  bad: colors.redFg,
  off: colors.muted,
} as const;

const styles = StyleSheet.create({
  modal: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 12,
    padding: 16,
    width: '92%',
    maxWidth: 420,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  close: { color: colors.muted, fontSize: 14, paddingHorizontal: 6 },
  section: {
    color: colors.faint,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    fontWeight: '700',
    marginBottom: 8,
  },
  label: { color: colors.muted, fontSize: 12, marginBottom: 4 },
  input: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 8,
    color: colors.text,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  notes: { minHeight: 64, textAlignVertical: 'top' },
  hint: { color: colors.faint, fontSize: 11, lineHeight: 15, marginTop: -4, marginBottom: 8 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 10 },
  error: { color: colors.redFg, fontSize: 12, marginBottom: 8 },
  closedBanner: {
    color: colors.yellowPillFg,
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 10,
    padding: 8,
    borderWidth: 1,
    borderColor: colors.yellowPillFg,
    borderRadius: 8,
  },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  footerRight: { flexDirection: 'row', gap: 8 },
  closeAccountBtn: {
    borderWidth: 1,
    borderColor: colors.redFg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  closeAccountText: { color: colors.redFg, fontSize: 12, fontWeight: '700' },
  deleteBtn: {
    backgroundColor: colors.redFg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  deleteText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  ghostBtn: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  ghostText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  connBox: { gap: 8 },
  connRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  connGlyph: { fontSize: 14 },
  connName: { color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  connStatus: { fontSize: 11, fontWeight: '700', marginLeft: 'auto' },
  connActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8 },
  connBtn: { borderWidth: 1, borderColor: colors.border2, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  unlinkText: { color: colors.redFg, fontSize: 12, fontWeight: '700' },
  linkBox: { gap: 8 },
  chooseBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.indigo2,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chooseBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  linkBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.indigo2,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  linkBtnText: { color: colors.indigo3, fontSize: 12, fontWeight: '700' },
  linkedCard: {
    padding: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card2,
    gap: 6,
  },
  followLabel: { color: colors.faint, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  warnBtn: {
    borderWidth: 1,
    borderColor: colors.yellowPillFg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  warnText: { color: colors.yellowPillFg, fontSize: 12, fontWeight: '700' },
  indigoBtn: {
    backgroundColor: colors.indigo,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  indigoText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  confirmScrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(11,14,20,.78)',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  confirmBox: {
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 12,
    padding: 14,
    width: '100%',
    maxWidth: 380,
  },
  confirmTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 8 },
  confirmBody: { color: colors.text, fontSize: 13, lineHeight: 18 },
  confirmBodyStrong: { fontWeight: '700' },
  helpbox: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 8,
    backgroundColor: colors.bg2,
  },
  confirmFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
});
