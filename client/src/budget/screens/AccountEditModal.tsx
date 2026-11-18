/**
 * Edit Account modal — YNAB parity (right-click an account in the rail).
 *
 * "Account Information" (nickname + notes), a "Working Balance" editor that
 * SETS the balance directly (an override — no ledger entry is created; the
 * /reconcile flow is the ledger-preserving counterpart), and a Close Account
 * action in the footer.
 */

import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { AccountRow } from '../data/rows';
import { KeyboardModalFrame } from '../ui/KeyboardModalFrame';
import { colors } from '../ui/theme';
import { PersonPicker } from './PersonPicker';
import { BankConnectionSection } from './accountEdit/BankConnectionSection';
import { CloseAccountConfirm } from './accountEdit/CloseAccountConfirm';
import { DeleteAccountConfirm } from './accountEdit/DeleteAccountConfirm';
import { styles } from './accountEdit/styles';
import { useAccountEdit } from './accountEdit/useAccountEdit';
import { UpstreamPickerSheet } from './bank/LinkSheets';
import { UnlinkConfirm } from './bank/UnlinkConfirm';

export function AccountEditModal({
  account,
  budgetId,
  onClose,
}: {
  account: AccountRow | null;
  budgetId: string;
  onClose: () => void;
}) {
  const edit = useAccountEdit(account, budgetId, onClose);
  if (!account || !edit) return null;
  const {
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
    upstream,
    budgetAccounts,
    pickerOpen,
    setPickerOpen,
    unlinkAsk,
    setUnlinkAsk,
    unlink,
    linkBusy,
  } = edit;

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
            value={balance.text}
            onChangeText={(t) => setBalanceDraft(t)}
            editable={!isLoading && !account.closed}
            inputMode="decimal"
          />
          {balance.changed ? (
            <Text style={styles.hint}>
              Sets the balance directly — an override, not a ledger entry.
            </Text>
          ) : null}

          <View style={styles.divider} />

          <Text style={styles.section}>BANK CONNECTION</Text>
          <BankConnectionSection edit={edit} />

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
          <CloseAccountConfirm
            amount={closeAsk.amount}
            onBudget={account.on_budget}
            busy={isLoading}
            onCancel={() => setCloseAsk(null)}
            onConfirm={() => void closeAccount()}
          />
        ) : null}

        {unlinkAsk ? (
          <Pressable style={styles.confirmScrim} onPress={(e) => e.stopPropagation()}>
            <View style={styles.confirmBox}>
              <UnlinkConfirm
                accountName={account.name}
                busy={linkBusy}
                onCancel={() => setUnlinkAsk(false)}
                onConfirm={() => void unlink()}
              />
            </View>
          </Pressable>
        ) : null}

        {deleteAsk ? (
          <DeleteAccountConfirm
            accountName={account.name}
            deleting={deleting}
            onCancel={() => setDeleteAsk(false)}
            onConfirm={() => void deleteAccountForever()}
          />
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
