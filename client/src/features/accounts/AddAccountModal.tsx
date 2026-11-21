/**
 * Add Account modal — YNAB parity (the "+ Add Account" entry under the rail's
 * account groups). Picks an account type (grouped Cash / Credit / Debt &
 * Loans), names the account, and optionally books a "Starting Balance"
 * transaction server-side when an opening balance is given.
 *
 * Also the route INTO bank linking: a created account lands in the account
 * editor (`?edit=1`), whose bank section links one upstream account 1:1.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import { useAddAccountMutation } from '@/budget/data/api';
import type { AccountTypeRow } from '@/budget/data/rows';
import { PersonPicker } from '@/features/people';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { KeyboardModalFrame } from '@/ui/KeyboardModalFrame';
import { colors } from '@/ui/theme';
import { tCommon } from '@shared/i18n/common';
import { t } from './i18n';

const typeGroups = (): { title: string; options: { value: AccountTypeRow; label: string }[] }[] => [
  {
    title: t('add.group.cash'),
    options: [
      { value: 'checking', label: t('accountType.checking') },
      { value: 'savings', label: t('accountType.savings') },
      { value: 'cash', label: t('accountType.cash') },
    ],
  },
  {
    title: t('add.group.credit'),
    options: [
      { value: 'creditCard', label: t('accountType.creditCard') },
      { value: 'lineOfCredit', label: t('add.type.lineOfCredit') },
    ],
  },
  {
    title: t('add.group.debt'),
    options: [
      { value: 'otherLiability', label: t('add.type.otherLiability') },
      { value: 'mortgage', label: t('add.type.mortgage') },
      { value: 'autoLoan', label: t('add.type.autoLoan') },
      { value: 'studentLoan', label: t('add.type.studentLoan') },
      { value: 'personalLoan', label: t('add.type.personalLoan') },
      { value: 'medicalDebt', label: t('add.type.medicalDebt') },
      { value: 'otherDebt', label: t('add.type.otherDebt') },
    ],
  },
];

export function AddAccountModal({
  budgetId,
  visible,
  onClose,
}: {
  budgetId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { formatMoney, parseMoney } = useMoneyFormat();
  const [addAccount, { isLoading }] = useAddAccountMutation();
  const router = useRouter();
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountTypeRow>('checking');
  const [balanceText, setBalanceText] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setType('checking');
    setBalanceText('');
    setUserId(null);
    setError(null);
  };

  /** Shared validation + account creation for both completion paths. */
  const createReturningId = async (): Promise<string | null> => {
    if (!name.trim()) {
      setError(t('add.nameRequired'));
      return null;
    }
    const balance = parseMoney(balanceText || '0');
    try {
      const row = await addAccount({
        budgetId,
        name: name.trim(),
        type,
        balanceCents: balance,
        userId,
      }).unwrap();
      return row.id;
    } catch (err) {
      setError(apiErrorMessage(err, t('add.createFailed')));
      return null;
    }
  };

  const create = async () => {
    const id = await createReturningId();
    if (id == null) return;
    reset();
    onClose();
    // New accounts land in the editor (?edit=1): bank linking is a 1:1 choice
    // made in its bank section, not a second button here.
    router.replace(`/accounts?account=${id}&edit=1` as never);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardModalFrame onBackdropPress={onClose} cardStyle={styles.modal}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.title}>{t('add.title')}</Text>
            <Pressable
              onPress={() => {
                reset();
                onClose();
              }}
              accessibilityLabel={tCommon('close')}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <Text style={styles.label}>{t('add.nameLabel')}</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder={t('add.namePlaceholder')}
            placeholderTextColor={colors.faint}
            editable={!isLoading}
            autoFocus
          />

          <Text style={styles.label}>{t('add.typeLabel')}</Text>
          <ScrollView style={styles.typeList} nestedScrollEnabled>
            {typeGroups().map((g) => (
              <View key={g.title}>
                <Text style={styles.typeGroup}>{g.title}</Text>
                <View style={styles.typeRow}>
                  {g.options.map((o) => (
                    <Pressable
                      key={o.value}
                      style={[styles.typeChip, type === o.value && styles.typeChipOn]}
                      disabled={isLoading}
                      onPress={() => setType(o.value)}>
                      <Text style={[styles.typeText, type === o.value && styles.typeTextOn]}>
                        {o.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}
          </ScrollView>

          <Text style={styles.label}>{t('add.person')}</Text>
          <PersonPicker budgetId={budgetId} value={userId} onChange={setUserId} disabled={isLoading} />

          <Text style={styles.label}>{t('add.openingBalance')}</Text>
          <TextInput
            style={styles.input}
            value={balanceText}
            onChangeText={setBalanceText}
            placeholder={formatMoney(0)}
            placeholderTextColor={colors.faint}
            editable={!isLoading}
            inputMode="decimal"
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.footer}>
            <Pressable
              style={styles.ghostBtn}
              disabled={isLoading}
              onPress={() => {
                reset();
                onClose();
              }}>
              <Text style={styles.ghostText}>{tCommon('cancel')}</Text>
            </Pressable>
            <Pressable style={styles.indigoBtn} disabled={isLoading} onPress={() => void create()}>
              <Text style={styles.indigoText}>{t('add.create')}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardModalFrame>
    </Modal>
  );
}

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
    marginBottom: 12,
  },
  typeList: { maxHeight: 200, marginBottom: 12 },
  typeGroup: {
    color: colors.faint,
    fontSize: 10,
    letterSpacing: 1.2,
    fontWeight: '700',
    marginTop: 6,
    marginBottom: 4,
  },
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  typeChip: {
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  typeChipOn: { borderColor: colors.indigo2, backgroundColor: colors.indigo },
  typeText: { color: colors.muted, fontSize: 12 },
  typeTextOn: { color: colors.white, fontWeight: '700' },
  error: { color: colors.redFg, fontSize: 12, marginBottom: 8 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  ghostBtn: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  ghostText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  indigoBtn: {
    backgroundColor: colors.indigo,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  indigoText: { color: colors.white, fontSize: 12, fontWeight: '700' },
});
