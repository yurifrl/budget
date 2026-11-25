/**
 * One queue row, shared by the expanded bundle cards, the "No suggestion"
 * group and the manual (one-by-one) list: date, payee and raw bank text,
 * account, signed amount, the row's chips (press to file) and the category
 * search. Layout wraps on narrow widths instead of clipping.
 */

import { StyleSheet, Text, View } from 'react-native';

import type { CategorizeQueueRow, CategorizeSuggestion } from '@/budget/data/api';
import { milliToCents } from '@/budget/data/mapping';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';

import { CategoryPicker, ConfidenceChip } from './CategorizeBits';
import { t } from './i18n';
import type { PickedCategory } from './page.logic';
import { manualStateLabel, topSuggestions } from './queue.logic';

export function QueueRowView({
  row,
  budgetId,
  onFileSuggestion,
  onPickCategory,
  disabled,
  showState,
}: {
  row: CategorizeQueueRow;
  budgetId: string | null;
  onFileSuggestion: (suggestion: CategorizeSuggestion) => void;
  onPickCategory: (category: PickedCategory) => void;
  disabled?: boolean;
  /** Manual rows show why they have no suggestion. */
  showState?: boolean;
}) {
  const { formatMoney, formatDate } = useMoneyFormat();
  const chips = topSuggestions(row.suggestions);
  const payee = row.payee?.trim() || t('row.unnamed');
  const raw = row.raw_bank_description?.trim();
  return (
    <View style={styles.row}>
      <Text style={styles.date}>{formatDate(row.date)}</Text>
      <View style={styles.who}>
        <Text style={styles.payee} numberOfLines={1}>
          {payee}
        </Text>
        {raw && raw !== payee ? (
          <Text style={styles.raw} numberOfLines={1}>
            {raw}
          </Text>
        ) : null}
      </View>
      <Text style={styles.account} numberOfLines={1}>
        {row.account_name}
      </Text>
      <Text style={[styles.amount, row.amount < 0 ? styles.out : styles.in]}>
        {formatMoney(milliToCents(row.amount))}
      </Text>
      <View style={styles.chips}>
        {chips.map((suggestion, index) => (
          <ConfidenceChip
            key={`${suggestion.category_id}-${index}`}
            suggestion={suggestion}
            onPress={disabled ? undefined : () => onFileSuggestion(suggestion)}
          />
        ))}
        {showState && chips.length === 0 ? <Text style={styles.state}>{manualStateLabel(row.state)}</Text> : null}
      </View>
      <CategoryPicker
        budgetId={budgetId}
        disabled={disabled}
        label={t('row.chooseA11y', { payee })}
        onPick={onPickCategory}
        style={styles.picker}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  date: { color: colors.muted, fontSize: 12, width: 90, minWidth: 90, flexShrink: 0 },
  who: { flexGrow: 1.4, flexBasis: 180, minWidth: 150 },
  payee: { color: colors.text, fontSize: 13, fontWeight: '600' },
  raw: { color: colors.faint, fontSize: 11, marginTop: 1 },
  account: { color: colors.muted, fontSize: 12, flexGrow: 0.6, flexBasis: 100, minWidth: 90 },
  amount: { fontSize: 13, fontWeight: '700', textAlign: 'right', minWidth: 92 },
  out: { color: colors.redFg },
  in: { color: colors.greenPillFg },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', flexGrow: 1, flexBasis: 220 },
  state: { color: colors.faint, fontSize: 11, fontStyle: 'italic' },
  picker: { minWidth: 132, flexGrow: 0 },
});
