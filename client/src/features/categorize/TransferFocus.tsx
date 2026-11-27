/**
 * The focused Jev transfer answer (One by one): the row's own facts, the
 * account the money moved to or came from, the certainty, and the two answers
 * that are not a category — accept the transfer or say it is not one. There is
 * no category picker here: a transfer between own accounts carries no category.
 */

import { Platform, StyleSheet, Text, View } from 'react-native';

import { milliToCents } from '@/budget/data/mapping';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';

import { KeyButton } from './CategorizeBits';
import { t } from './i18n';
import { thresholdPercent } from './page.logic';
import { confidenceBand, type ConfidenceBand } from './queue.logic';
import { transferHeading, type TransferItem } from './transfer.logic';

const SHOW_KEYS = Platform.OS === 'web';

const BAND_COLOR: Record<ConfidenceBand, string> = {
  high: colors.greenPillFg,
  mid: colors.yellowPillFg,
  low: colors.muted,
};

export function TransferFocus({
  item,
  canUndo,
  onAccept,
  onRefuse,
  onSkip,
  onUndo,
}: {
  item: TransferItem;
  canUndo: boolean;
  onAccept: () => void;
  onRefuse: () => void;
  onSkip: () => void;
  onUndo: () => void;
}) {
  const { formatMoney, formatDate } = useMoneyFormat();
  const payee = item.payee.trim() === '' ? t('row.unnamed') : item.payee;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.payee} numberOfLines={2}>
            {payee}
          </Text>
          <Text style={styles.amount}>{formatMoney(milliToCents(item.amount))}</Text>
        </View>
        <Text style={[styles.percent, { color: BAND_COLOR[confidenceBand(item.confidence)] }]}>
          {t('transfer.percent', { percent: thresholdPercent(item.confidence) })}
        </Text>
      </View>

      <View style={styles.fields}>
        <Field label={t('transfer.focusLabel')} value={transferHeading(item)} />
        <Field label={t('one.date')} value={formatDate(item.date)} />
        <Field label={t('one.account')} value={item.account_name} />
      </View>

      <Text style={styles.hint}>{t('transfer.focusHint')}</Text>

      <View style={styles.actions}>
        <KeyButton
          label={t('transfer.accept')}
          keyLabel={SHOW_KEYS ? '1' : undefined}
          onPress={onAccept}
          primary
        />
        <KeyButton
          label={t('transfer.refuse')}
          keyLabel={SHOW_KEYS ? 'N' : undefined}
          onPress={onRefuse}
        />
        <KeyButton
          label={t('transfer.skip')}
          keyLabel={SHOW_KEYS ? 'S' : undefined}
          onPress={onSkip}
        />
        <KeyButton
          label={t('one.undoLast')}
          keyLabel={SHOW_KEYS ? 'Z' : undefined}
          onPress={onUndo}
          disabled={!canUndo}
        />
      </View>
    </View>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.fieldValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 9,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  payee: { color: colors.text, fontSize: 16, fontWeight: '700' },
  amount: { color: colors.text, fontSize: 15, fontWeight: '600' },
  percent: { fontSize: 13, fontWeight: '700' },
  fields: { gap: 8 },
  field: { gap: 2 },
  label: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  fieldValue: { color: colors.text, fontSize: 13 },
  hint: { color: colors.faint, fontSize: 11, lineHeight: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
});
