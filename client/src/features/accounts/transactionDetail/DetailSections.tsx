/**
 * Building blocks of the transaction page: a titled card, a label/value
 * list, a copy action, the split legs and the Import section.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import type { TransactionDetails } from '@/budget/data/api';
import { copyText } from '@/platform/clipboard/copyText';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';

import { t } from './i18n';
import { styles } from './styles';
import { formatMilli, formatTimestamp, type FieldRow } from './transactionDetail.logic';

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle} accessibilityRole="header">
          {title}
        </Text>
        {action}
      </View>
      {children}
    </View>
  );
}

export function FieldList({ rows, phone }: { rows: FieldRow[]; phone: boolean }) {
  return (
    <View>
      {rows.map((r, i) => (
        <View key={r.key} style={[styles.row, i === rows.length - 1 && styles.rowLast]}>
          <Text style={[styles.label, phone && styles.labelPhone]}>{r.label}</Text>
          <Text selectable style={[styles.value, r.mono && styles.mono]}>
            {r.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Copies `text` (web clipboard; the share sheet on native) and marks "Copied" for a moment. */
export function CopyButton({ label, text, iconOnly = false }: { label: string; text: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const onPress = () => {
    void copyText(text).then((ok) => setCopied(ok));
  };
  const icon = copied ? 'checkmark' : 'copy-outline';
  if (iconOnly) {
    return (
      <Pressable onPress={onPress} style={styles.iconBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel={label}>
        <Ionicons name={icon} size={14} color={colors.indigo3} />
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onPress} style={styles.action} accessibilityRole="button" accessibilityLabel={label}>
      <Ionicons name={icon} size={13} color={colors.indigo3} />
      <Text style={styles.actionText}>{copied ? t('copy.done') : label}</Text>
    </Pressable>
  );
}

/** Split legs: category, memo, amount. */
export function SplitsSection({ subs }: { subs: TransactionDetails['transaction']['subtransactions'] }) {
  const fmt = useMoneyFormat();
  return (
    <Section title={t('section.splits')}>
      {subs.map((s, i) => (
        <View key={s.id} style={[styles.row, i === subs.length - 1 && styles.rowLast]}>
          <Text style={styles.value} selectable>
            {[s.category_name ?? t('value.uncategorized'), s.memo].filter(Boolean).join(' · ')}
          </Text>
          <Text style={[styles.value, { flex: 0 }]}>{formatMilli(fmt, s.amount)}</Text>
        </View>
      ))}
    </Section>
  );
}

/** Bank, provider, bank id (copyable), connection and sync state; or the hand-entered note. */
export function ImportSection({ imp, phone }: { imp: TransactionDetails['import']; phone: boolean }) {
  const fmt = useMoneyFormat();
  if (!imp) {
    return (
      <Section title={t('section.import')}>
        <Text style={[styles.hint, { textAlign: 'left', paddingVertical: 6 }]}>{t('import.manual')}</Text>
      </Section>
    );
  }
  const labelStyle = [styles.label, phone && styles.labelPhone];
  const edited = imp.state === 'edited';
  return (
    <Section title={t('section.import')}>
      <FieldList
        phone={phone}
        rows={[
          { key: 'bank', label: t('import.bank'), value: imp.bank_name ?? (imp.connection_id ? '—' : t('import.unlinked')) },
          { key: 'provider', label: t('import.provider'), value: imp.provider },
        ]}
      />
      <View style={styles.row}>
        <Text style={labelStyle}>{t('import.bankId')}</Text>
        <Text selectable style={[styles.value, styles.mono]}>
          {imp.bank_transaction_id}
        </Text>
        <CopyButton iconOnly label={t('copy.bankId')} text={imp.bank_transaction_id} />
      </View>
      <View style={styles.row}>
        <Text style={labelStyle}>{t('import.state')}</Text>
        <Text style={[styles.value, edited && styles.stateEdited]}>
          {edited ? t('import.stateEdited') : t('import.stateImported')}
        </Text>
      </View>
      <FieldList
        phone={phone}
        rows={[
          ...(imp.connection_id
            ? [{ key: 'connection', label: t('import.connection'), value: imp.connection_id, mono: true }]
            : []),
          ...(imp.raw_received_at
            ? [{ key: 'received', label: t('import.receivedAt'), value: formatTimestamp(fmt, imp.raw_received_at) }]
            : []),
          { key: 'updated', label: t('import.updatedAt'), value: formatTimestamp(fmt, imp.updated_at) },
        ]}
      />
    </Section>
  );
}
