/**
 * Edit Account modal — YNAB parity (right-click an account in the rail).
 *
 * "Account Information" (nickname + notes), a "Working Balance" editor that
 * SETS the balance directly (an override — no ledger entry is created; the
 * /reconcile flow is the ledger-preserving counterpart), and a Close Account
 * action in the footer.
 */

import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { AccountRow } from '@/budget/data/rows';
import { KeyboardModalFrame } from '@/ui/KeyboardModalFrame';
import { colors } from '@/ui/theme';
import { PersonPicker } from '@/features/people';
import { BankConnectionSection } from './accountEdit/BankConnectionSection';
import { CloseAccountConfirm } from './accountEdit/CloseAccountConfirm';
import { DeleteAccountConfirm } from './accountEdit/DeleteAccountConfirm';
import { styles } from './accountEdit/styles';
import { useAccountEdit } from './accountEdit/useAccountEdit';
import { UpstreamPickerSheet , UnlinkConfirm } from '@/features/banks';
import { tCommon } from '@shared/i18n/common';
import { t } from './i18n';

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
            <Text style={styles.title}>{t('action.editAccount')}</Text>
            <Pressable onPress={onClose} accessibilityLabel={tCommon('close')}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          {account.closed ? (
            <Text style={styles.closedBanner}>
              {t('edit.closedBanner')}
            </Text>
          ) : null}

          <Text style={styles.section}>{t('edit.sectionInfo')}</Text>
          <Text style={styles.label}>{t('edit.nickname')}</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder={t('edit.nicknamePlaceholder')}
            placeholderTextColor={colors.faint}
            editable={!isLoading && !account.closed}
          />
          <Text style={styles.label}>{t('edit.notes')}</Text>
          <TextInput
            style={[styles.input, styles.notes]}
            value={note}
            onChangeText={setNote}
            placeholder={t('edit.notesPlaceholder')}
            placeholderTextColor={colors.faint}
            multiline
            editable={!isLoading && !account.closed}
          />

          <Text style={styles.label}>{t('edit.person')}</Text>
          <PersonPicker
            budgetId={budgetId}
            value={userId}
            onChange={setUserId}
            disabled={isLoading || account.closed}
          />

          <View style={styles.divider} />

          <Text style={styles.label}>{t('edit.workingBalance')}</Text>
          <TextInput
            style={styles.input}
            value={balance.text}
            onChangeText={(text) => setBalanceDraft(text)}
            editable={!isLoading && !account.closed}
            inputMode="decimal"
          />
          {balance.changed ? (
            <Text style={styles.hint}>
              {t('edit.balanceHint')}
            </Text>
          ) : null}

          <View style={styles.divider} />

          <Text style={styles.section}>{t('edit.sectionBank')}</Text>
          <BankConnectionSection edit={edit} />

          <View style={styles.divider} />

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.footer}>
            {account.closed ? (
              <>
                <Pressable style={styles.closeAccountBtn} disabled={isLoading} onPress={() => void save(false)}>
                  <Text style={styles.closeAccountText}>{t('edit.reopen')}</Text>
                </Pressable>
                <Pressable style={styles.deleteBtn} disabled={deleting || isLoading} onPress={() => setDeleteAsk(true)}>
                  <Text style={styles.deleteText}>{deleting ? t('edit.deleting') : tCommon('delete')}</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                style={styles.closeAccountBtn}
                disabled={isLoading}
                onPress={() => setCloseAsk({ amount: working })}>
                <Text style={styles.closeAccountText}>{t('edit.closeAccount')}</Text>
              </Pressable>
            )}
            <View style={styles.footerRight}>
              <Pressable style={styles.ghostBtn} disabled={isLoading} onPress={onClose}>
                <Text style={styles.ghostText}>{tCommon('cancel')}</Text>
              </Pressable>
              {account.closed ? null : (
                <Pressable style={styles.indigoBtn} disabled={isLoading} onPress={() => void save()}>
                  <Text style={styles.indigoText}>{tCommon('save')}</Text>
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
