/**
 * The manual queue: every row the queue could not suggest a category for,
 * with the category search per row. This is the destination of the empty
 * state's "Categorize by hand" and a minimal stand-in for the One by one view
 * until that view (focus pane and keyboard) lands.
 */

import { StyleSheet, Text, View } from 'react-native';

import type { CategorizeQueueRow, CategorizeSuggestion } from '@/budget/data/api';
import { colors, radius } from '@/ui/theme';

import { t } from './i18n';
import type { PickedCategory } from './page.logic';
import { QueueRowView } from './QueueRowView';

export function ManualQueueView({
  budgetId,
  rows,
  total,
  idle,
  onFileRow,
  onPickCategory,
}: {
  budgetId: string | null;
  rows: readonly CategorizeQueueRow[];
  /** Whole-queue rows (the page holds the first page). */
  total: number;
  idle: boolean;
  onFileRow: (row: CategorizeQueueRow, suggestion: CategorizeSuggestion) => void;
  onPickCategory: (row: CategorizeQueueRow, category: PickedCategory) => void;
}) {
  if (rows.length === 0) {
    return <Text style={styles.empty}>{t('queue.empty')}</Text>;
  }
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.title}>{t('queue.manualTitle')}</Text>
        <Text style={styles.hint}>{t('queue.manualHint')}</Text>
      </View>
      <View style={styles.list}>
        {rows.map((row) => (
          <QueueRowView
            key={row.transaction_id}
            row={row}
            budgetId={budgetId}
            disabled={!idle}
            showState
            onFileSuggestion={(suggestion) => onFileRow(row, suggestion)}
            onPickCategory={(category) => onPickCategory(row, category)}
          />
        ))}
        {rows.length < total ? (
          <Text style={styles.truncated}>{t('noSuggestion.truncated', { shown: rows.length, count: total })}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  head: { gap: 3 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  hint: { color: colors.muted, fontSize: 12 },
  list: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  truncated: { color: colors.faint, fontSize: 11, padding: 12 },
  empty: { color: colors.muted, fontSize: 13, paddingVertical: 40, textAlign: 'center' },
});
