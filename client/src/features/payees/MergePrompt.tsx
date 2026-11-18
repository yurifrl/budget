import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Combobox } from '@/ui/combobox';

import type { PayeeAdminRow } from '@/budget/data/rows';
import { styles } from './styles';

/** Delete-with-transactions fallback: merge into a surviving payee. */
export function MergePrompt({
  payee,
  candidates,
  targetId,
  onTargetChange,
  onConfirm,
  onCancel,
}: {
  payee: PayeeAdminRow;
  candidates: PayeeAdminRow[];
  targetId: string | null;
  onTargetChange: (id: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Live search text; the same select pattern the transaction import uses
  // for payee association (Combobox filters options as you type).
  const [query, setQuery] = useState('');
  return (
    <>
      <Text style={styles.sectionLabel}>MERGE PAYEE</Text>
      <Text style={styles.mergeCopy}>
        “{payee.name}” has {payee.transaction_count} transaction{payee.transaction_count === 1 ? '' : 's'}. Choose a
        payee to merge it into — its transactions move to that payee.
      </Text>
      <Combobox
        value={query}
        onChangeText={setQuery}
        options={candidates.map((c) => ({ key: c.id, label: c.name }))}
        onPick={(key) => {
          onTargetChange(key);
          setQuery(candidates.find((c) => c.id === key)?.name ?? '');
        }}
        placeholder="Search payees…"
        chevron
        autoFocus
        containerStyle={styles.mergeSelect}
        accessibilityLabel="Payee to merge into"
      />
      <View style={styles.footerRow}>
        <Pressable onPress={onCancel} accessibilityRole="button">
          <Text style={styles.linkText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          disabled={!targetId}
          style={styles.mergeBtn}
          accessibilityRole="button">
          <Text style={styles.mergeBtnText}>Merge</Text>
        </Pressable>
      </View>
    </>
  );
}
