import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Combobox } from '@/ui/combobox';

import type { PayeeAdminRow } from '@/budget/data/rows';
import { tCommon } from '@shared/i18n/common';
import { t } from './i18n';
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
      <Text style={styles.sectionLabel}>{t('merge.title')}</Text>
      <Text style={styles.mergeCopy}>
        {t('merge.body', { name: payee.name, count: payee.transaction_count })}
      </Text>
      <Combobox
        value={query}
        onChangeText={setQuery}
        options={candidates.map((c) => ({ key: c.id, label: c.name }))}
        onPick={(key) => {
          onTargetChange(key);
          setQuery(candidates.find((c) => c.id === key)?.name ?? '');
        }}
        placeholder={t('merge.search')}
        chevron
        autoFocus
        containerStyle={styles.mergeSelect}
        accessibilityLabel={t('merge.targetLabel')}
      />
      <View style={styles.footerRow}>
        <Pressable onPress={onCancel} accessibilityRole="button">
          <Text style={styles.linkText}>{tCommon('cancel')}</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          disabled={!targetId}
          style={styles.mergeBtn}
          accessibilityRole="button">
          <Text style={styles.mergeBtnText}>{t('merge.confirm')}</Text>
        </Pressable>
      </View>
    </>
  );
}
