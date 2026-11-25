/**
 * The One by one view (mock ev-b2073b): the queue on the left, the focused
 * transaction on the right, a progress counter and the key legend. On narrow
 * widths the two columns stack: the focused transaction first, then the queue.
 */

import { useEffect } from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { CategorizeQueueRow } from '@/budget/data/api';
import { colors } from '@/ui/theme';

import { KeyCap } from './CategorizeBits';
import { FocusPane } from './FocusPane';
import { t } from './i18n';
import { progressLabel } from './oneByOne.logic';
import { QueuePane } from './QueuePane';
import type { OneByOne } from './useOneByOne';

const SHOW_KEYS = Platform.OS === 'web';
/** Below this window width the rail plus two columns no longer fit: the columns stack. */
const STACK_BELOW = 1180;
/** Below this width the key legend would not fit beside the counter. */
const LEGEND_MIN = 760;

export function OneByOneView({
  budgetId,
  flow,
  total,
  loadedRows,
}: {
  budgetId: string | null;
  flow: OneByOne;
  /** Whole-queue size, for the list header. */
  total: number;
  /** Rows the page holds (the queue is read in pages). */
  loadedRows: number;
}) {
  const { focused, progress } = flow;
  const width = useWindowDimensions().width;
  const stacked = width < STACK_BELOW;

  // A control left focused by the view switch would claim Enter.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web' && typeof document !== 'undefined') {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  }, []);

  if (!focused) {
    return <Text style={styles.empty}>{t('one.allDone')}</Text>;
  }
  const row: CategorizeQueueRow = focused;
  const queue = (
    <View style={[styles.queueCol, stacked && styles.queueColStacked]} key="queue">
      <QueuePane
        rows={flow.rows}
        filed={flow.filed}
        pendingSkips={flow.pendingSkips}
        onCancelSkip={flow.cancelSkip}
        focusedId={row.transaction_id}
        total={total}
        hiddenBelow={Math.max(0, total - loadedRows)}
        onFocus={flow.focusRow}
      />
    </View>
  );
  const detail = (
    <View style={[styles.focusCol, stacked && styles.focusColStacked]} key="detail">
      <View style={styles.progressRow}>
        <Text style={styles.counter}>{progressLabel(progress)}</Text>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.round(progress.fraction * 100)}%` }]} />
        </View>
        {SHOW_KEYS && width >= LEGEND_MIN ? <Legend /> : null}
      </View>
      <FocusPane
        row={row}
        budgetId={budgetId}
        canUndo={flow.canUndo}
        searchRef={flow.searchRef}
        onFile={flow.file}
        onPick={flow.pick}
        onSkip={flow.skip}
        onUndo={flow.undo}
      />
    </View>
  );
  return <View style={[styles.wrap, stacked && styles.wrapStacked]}>{stacked ? [detail, queue] : [queue, detail]}</View>;
}

function Legend() {
  const items: { keys: string[]; label: string }[] = [
    { keys: ['1', '2', '3'], label: t('one.keys.pick') },
    { keys: [t('one.keys.enterKey')], label: t('one.keys.confirm') },
    { keys: ['S'], label: t('one.keys.skip') },
    { keys: ['/'], label: t('one.keys.search') },
    { keys: ['Z'], label: t('one.keys.undo') },
  ];
  return (
    <View style={styles.legend}>
      {items.map((item) => (
        <View key={item.label} style={styles.legendItem}>
          {item.keys.map((key) => (
            <KeyCap key={key} label={key} />
          ))}
          <Text style={styles.legendLabel}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
  wrapStacked: { flexDirection: 'column', alignItems: 'stretch' },
  queueCol: { width: 330, flexShrink: 0 },
  queueColStacked: { width: '100%' },
  focusCol: { flex: 1, minWidth: 0, gap: 14 },
  focusColStacked: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%' },
  progressRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  counter: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  track: { flexGrow: 1, flexBasis: 80, maxWidth: 220, height: 6, borderRadius: 3, backgroundColor: colors.border },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.green },
  legend: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginLeft: 'auto' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendLabel: { color: colors.muted, fontSize: 12, marginLeft: 2 },
  empty: { color: colors.muted, fontSize: 14, paddingVertical: 48, textAlign: 'center' },
});
