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

import { useAddAccountMutation } from '../data/api';
import type { AccountTypeRow } from '../data/rows';
import { PersonPicker } from './PersonPicker';
import { formatMoney, parseMoney } from '../domain/format';
import { KeyboardModalFrame } from '../ui/KeyboardModalFrame';
import { colors } from '../ui/theme';

const TYPE_GROUPS: { title: string; options: { value: AccountTypeRow; label: string }[] }[] = [
  {
    title: 'Cash',
    options: [
      { value: 'checking', label: 'Checking' },
      { value: 'savings', label: 'Savings' },
      { value: 'cash', label: 'Cash' },
    ],
  },
  {
    title: 'Credit',
    options: [
      { value: 'creditCard', label: 'Credit Card' },
      { value: 'lineOfCredit', label: 'Line of Credit' },
    ],
  },
  {
    title: 'Debt & Loans',
    options: [
      { value: 'otherLiability', label: 'Other Liability' },
      { value: 'mortgage', label: 'Mortgage' },
      { value: 'autoLoan', label: 'Auto Loan' },
      { value: 'studentLoan', label: 'Student Loan' },
      { value: 'personalLoan', label: 'Personal Loan' },
      { value: 'medicalDebt', label: 'Medical Debt' },
      { value: 'otherDebt', label: 'Other Debt' },
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
      setError('account name is required');
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
      setError(apiErrorMessage(err, 'failed to create account'));
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
            <Text style={styles.title}>Add Account</Text>
            <Pressable
              onPress={() => {
                reset();
                onClose();
              }}
              accessibilityLabel="Close">
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <Text style={styles.label}>Account Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Checking"
            placeholderTextColor={colors.faint}
            editable={!isLoading}
            autoFocus
          />

          <Text style={styles.label}>Account Type</Text>
          <ScrollView style={styles.typeList} nestedScrollEnabled>
            {TYPE_GROUPS.map((g) => (
              <View key={g.title}>
                <Text style={styles.typeGroup}>{g.title.toUpperCase()}</Text>
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

          <Text style={styles.label}>Person</Text>
          <PersonPicker budgetId={budgetId} value={userId} onChange={setUserId} disabled={isLoading} />

          <Text style={styles.label}>Opening Balance</Text>
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
              <Text style={styles.ghostText}>Cancel</Text>
            </Pressable>
            <Pressable style={styles.indigoBtn} disabled={isLoading} onPress={() => void create()}>
              <Text style={styles.indigoText}>Create Account</Text>
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
  typeTextOn: { color: '#fff', fontWeight: '700' },
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
  indigoText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
