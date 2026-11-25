/**
 * One bundle card (mock ev-2d6f08): payee + count + date range + total +
 * top-suggestion chip, an Accept button, and — when opened — its rows with
 * per-row chips and category search. Only the opened card fetches rows.
 */

import { StyleSheet, Text, View, Pressable } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import type { CategorizeBundle, CategorizeQueueRow, CategorizeSuggestion } from '@/budget/data/api';
import { milliToCents } from '@/budget/data/mapping';
import { GhostButton, IndigoButton } from '@/ui/bits';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors, radius } from '@/ui/theme';

import { ConfidenceChip, PayeeDot } from './CategorizeBits';
import { t } from './i18n';
import type { PickedCategory } from './page.logic';
import { bundleDateRange } from './queue.logic';
import { QueueRowView } from './QueueRowView';
import { useBundleRows } from './useBundleRows';

export function BundleCard({
  budgetId,
  bundle,
  expanded,
  onToggle,
  disabled,
  onAccept,
  onFileRow,
  onPickCategory,
}: {
  budgetId: string | null;
  bundle: CategorizeBundle;
  expanded: boolean;
  onToggle: () => void;
  disabled?: boolean;
  onAccept: (bundle: CategorizeBundle, rows: readonly CategorizeQueueRow[]) => void;
  onFileRow: (row: CategorizeQueueRow, suggestion: CategorizeSuggestion) => void;
  onPickCategory: (row: CategorizeQueueRow, category: PickedCategory) => void;
}) {
  const { formatMoney, formatDate } = useMoneyFormat();
  const rows = useBundleRows(budgetId, expanded ? bundle : null);
  const range = bundleDateRange(bundle, { formatDate });
  const total = formatMoney(Math.abs(milliToCents(bundle.total)));
  return (
    <View style={[styles.card, expanded && styles.cardOpen]}>
      <View style={styles.head}>
        <Pressable
          onPress={onToggle}
          style={({ pressed }) => [styles.open, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={
            expanded ? t('bundle.collapse', { payee: bundle.payee }) : t('bundle.expand', { payee: bundle.payee })
          }>
          <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
          <PayeeDot name={bundle.payee} />
          <View style={styles.who}>
            <Text style={styles.payee} numberOfLines={1}>
              {bundle.payee}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {t('bundle.meta', { count: bundle.count, range })}
            </Text>
          </View>
        </Pressable>
        <View style={styles.trail}>
          <Text style={styles.total}>{total}</Text>
          <Text style={styles.arrow}>→</Text>
          <ConfidenceChip suggestion={bundle.suggestion} />
          <IndigoButton
            label={t('bundle.accept')}
            onPress={() => onAccept(bundle, rows.rows)}
            disabled={disabled}
            style={styles.accept}
          />
        </View>
      </View>

      {expanded ? (
        <View>
          {rows.loading ? <Text style={styles.note}>{t('bundle.rowsLoading')}</Text> : null}
          {rows.error ? (
            <View style={styles.failed}>
              <Text style={styles.failedText}>{t('bundle.rowsFailed')}</Text>
              <GhostButton label={tCommon('retry')} onPress={() => void rows.refetch()} />
            </View>
          ) : null}
          {rows.rows.map((row) => (
            <QueueRowView
              key={row.transaction_id}
              row={row}
              budgetId={budgetId}
              disabled={disabled}
              onFileSuggestion={(suggestion) => onFileRow(row, suggestion)}
              onPickCategory={(category) => onPickCategory(row, category)}
            />
          ))}
          {rows.hasMore && rows.rows.length > 0 ? (
            <View style={styles.more}>
              <GhostButton
                label={rows.loadingMore ? tCommon('loading') : t('bundle.loadMore')}
                onPress={rows.loadMore}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  cardOpen: { borderColor: colors.indigo },
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12 },
  open: { flexDirection: 'row', alignItems: 'center', gap: 10, flexGrow: 1, flexBasis: 300, minWidth: 240, paddingVertical: 2 },
  pressed: { opacity: 0.85 },
  chevron: { color: colors.faint, fontSize: 14, width: 12 },
  who: { flex: 1, minWidth: 0 },
  payee: { color: colors.text, fontSize: 14, fontWeight: '700' },
  meta: { color: colors.faint, fontSize: 11, marginTop: 1 },
  trail: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  total: { color: colors.text, fontSize: 14, fontWeight: '700', minWidth: 92, textAlign: 'right' },
  arrow: { color: colors.faint, fontSize: 14 },
  accept: { backgroundColor: colors.green, paddingVertical: 7, paddingHorizontal: 13 },
  note: { color: colors.muted, fontSize: 12, padding: 12 },
  failed: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  failedText: { color: colors.redFg, fontSize: 12, flex: 1 },
  more: { padding: 10, alignItems: 'center' },
});
