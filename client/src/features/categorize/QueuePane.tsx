/**
 * The left side of the One by one view: the queue as a compact list (payee,
 * date and best category, amount, best confidence), the row in focus marked.
 * The list scrolls inside its own column; the page itself does not move while
 * rows are filed.
 */

import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';

import type { CategorizeQueueRow } from '@/budget/data/api';
import { milliToCents } from '@/budget/data/mapping';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';

import { t } from './i18n';
import type { UndoEntry } from './accept.logic';
import { leavingText, queueRowSubline, type FiledEntry } from './oneByOne.logic';
import { thresholdPercent } from './page.logic';
import { confidenceBand, type ConfidenceBand } from './queue.logic';
import { useNow } from './useNow';

const BAND_COLOR: Record<ConfidenceBand, string> = {
  high: colors.greenPillFg,
  mid: colors.yellowPillFg,
  low: colors.muted,
};

/** Rows of context kept above the focused row when the list scrolls to it. */
const ROWS_ABOVE = 2;

export function QueuePane({
  rows,
  filed,
  pendingSkips,
  onCancelSkip,
  focusedId,
  total,
  leaving,
  hiddenBelow,
  onFocus,
}: {
  rows: readonly CategorizeQueueRow[];
  /** Rows done this visit: dimmed lines above the queue, not focusable. */
  filed: readonly FiledEntry[];
  /** Skips waiting for their own timer: each shows its countdown and its own Undo. */
  pendingSkips: readonly Extract<UndoEntry, { kind: 'skip' }>[];
  onCancelSkip: (transactionId: string) => void;
  focusedId: string | null;
  /** Rows the queue holds (all of them, not only this page). */
  total: number;
  /** Skips still waiting for their timer; the total above still counts them. */
  leaving: number;
  /** Rows beyond the loaded page. */
  hiddenBelow: number;
  onFocus: (row: CategorizeQueueRow) => void;
}) {
  const { formatMoney, formatDateShort } = useMoneyFormat();
  const scroll = useRef<ScrollViewInstance>(null);
  const waiting = new Map(pendingSkips.map((entry) => [entry.item.transactionId, entry.sendAt]));
  const now = useNow(waiting.size > 0, [...waiting.values()].join(','));
  const layouts = useRef(new Map<string, { y: number; height: number }>());

  // Keep the focused row in view, with a couple of filed rows above it as the
  // mock shows. Scrolling to a row boundary never leaves a half-cut row on top.
  // The row's position is only known after layout, so a layout of the focused
  // row scrolls too (filing a row moves everything below it).
  const focusedRef = useRef(focusedId);
  focusedRef.current = focusedId;
  const scrollToFocused = () => {
    const at = focusedRef.current ? layouts.current.get(focusedRef.current) : undefined;
    if (at) scroll.current?.scrollTo({ y: Math.max(0, at.y - ROWS_ABOVE * at.height), animated: false });
  };
  useEffect(scrollToFocused, [focusedId]);

  const track = (id: string) => (e: { nativeEvent: { layout: { y: number; height: number } } }) => {
    layouts.current.set(id, { y: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height });
    if (id === focusedRef.current) scrollToFocused();
  };

  return (
    <View style={styles.pane}>
      <View style={styles.head}>
        <Text style={styles.title}>
          {t('one.queueTitle')}{' '}
          <Text style={styles.count}>
            {t('one.queueLeft', { count: total })}
            {leaving > 0 ? ` · ${t('one.queueLeaving', { count: leaving })}` : ''}
          </Text>
        </Text>
        <Text style={styles.order}>{t('one.queueOrder')}</Text>
      </View>
      <ScrollView ref={scroll} style={styles.list} nestedScrollEnabled>
        {filed.map(({ row, text }) => {
          const payee = row.payee?.trim() || row.raw_bank_description?.trim() || t('row.unnamed');
          const cents = milliToCents(row.amount);
          const sendAt = waiting.get(row.transaction_id);
          return (
            <View key={`filed-${row.transaction_id}`} style={[styles.row, styles.rowFiled, sendAt !== undefined && styles.rowLeaving]}>
              <View style={styles.rowText}>
                <Text style={styles.payeeFiled} numberOfLines={1}>
                  {payee}
                </Text>
                <Text style={sendAt !== undefined ? styles.leaving : styles.sub} numberOfLines={1}>
                  {sendAt !== undefined ? leavingText(sendAt, now) : `${formatDateShort(row.date)} · ✓ ${text}`}
                </Text>
              </View>
              {sendAt !== undefined ? (
                <Pressable
                  onPress={() => onCancelSkip(row.transaction_id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${t('undo')} ${payee}`}
                  hitSlop={6}>
                  <Text style={styles.undo}>{t('undo')}</Text>
                </Pressable>
              ) : null}
              <Text style={styles.amountFiled}>{formatMoney(cents)}</Text>
            </View>
          );
        })}
        {rows.map((row) => {
          const focused = row.transaction_id === focusedId;
          const payee = row.payee?.trim() || row.raw_bank_description?.trim() || t('row.unnamed');
          const cents = milliToCents(row.amount);
          const top = row.suggestions[0];
          return (
            <Pressable
              key={row.transaction_id}
              onLayout={track(row.transaction_id)}
              onPress={() => onFocus(row)}
              accessibilityRole="button"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={t('one.rowA11y', { payee, amount: formatMoney(cents) })}
              style={[styles.row, focused && styles.rowFocused]}>
              <View style={styles.rowText}>
                <Text style={styles.payee} numberOfLines={1}>
                  {payee}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {queueRowSubline(row, formatDateShort(row.date))}
                </Text>
              </View>
              <View style={styles.rowEnd}>
                <Text style={[styles.amount, cents > 0 && styles.in]}>{formatMoney(cents)}</Text>
                {top ? (
                  <Text style={[styles.percent, { color: BAND_COLOR[confidenceBand(top.confidence)] }]}>
                    {thresholdPercent(top.confidence)}%
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
        {hiddenBelow > 0 ? <Text style={styles.more}>{t('one.moreBelow', { count: hiddenBelow })}</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  pane: {
    width: '100%',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 9,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  title: { color: colors.text, fontSize: 13, fontWeight: '700' },
  count: { color: colors.muted, fontWeight: '500' },
  order: { color: colors.muted, fontSize: 11.5 },
  list: { maxHeight: 640 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  rowFiled: { opacity: 0.55 },
  // A pending skip is at full strength: it is the one thing on this list that can still be undone.
  rowLeaving: { opacity: 1, backgroundColor: colors.bg2 },
  leaving: { color: colors.yellowPillFg, fontSize: 11.5 },
  undo: { color: colors.indigo3, fontSize: 12.5, fontWeight: '700' },
  payeeFiled: { color: colors.muted, fontSize: 13.5, fontWeight: '600' },
  amountFiled: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  rowFocused: { backgroundColor: colors.indigoSoft, borderLeftColor: colors.indigo2 },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  payee: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
  sub: { color: colors.faint, fontSize: 11.5 },
  rowEnd: { alignItems: 'flex-end', gap: 1 },
  amount: { color: colors.text, fontSize: 13, fontWeight: '700' },
  in: { color: colors.greenPillFg },
  percent: { fontSize: 12, fontWeight: '700' },
  more: { color: colors.faint, fontSize: 12, textAlign: 'center', padding: 14 },
});
