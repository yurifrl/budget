/**
 * The left side of the One by one view: the lines still to answer as a compact
 * list (payee, date and what it looks like, amount, best confidence), the line
 * in focus marked. Jev's transfer answers lead the list; the queue rows follow
 * in their own order. The list scrolls inside its own column; the page itself
 * does not move while lines are filed.
 */

import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';

import { milliToCents } from '@/budget/data/mapping';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';

import { t } from './i18n';
import { paneLine, queueCounterLabel, type FiledEntry, type OneEntry } from './oneByOne.logic';
import { thresholdPercent } from './page.logic';
import { confidenceBand, type ConfidenceBand } from './queue.logic';

const BAND_COLOR: Record<ConfidenceBand, string> = {
  high: colors.greenPillFg,
  mid: colors.yellowPillFg,
  low: colors.muted,
};

/** Rows of context kept above the focused row when the list scrolls to it. */
const ROWS_ABOVE = 2;

export function QueuePane({
  entries,
  filed,
  focusedId,
  queueLeft,
  answers,
  matcherPairs,
  hiddenBelow,
  onFocus,
}: {
  /** The lines to answer: Jev's transfer answers, then the queue rows. */
  entries: readonly OneEntry[];
  /** Lines done this visit: dimmed above the list, not focusable. */
  filed: readonly FiledEntry[];
  focusedId: string | null;
  /** The category queue's rows still to answer (its own count, from the read). */
  queueLeft: number;
  /** Jev's transfer answers still listed (from the read that lists them). */
  answers: number;
  /** The matcher's pairs waiting: they are answered in Bundles, never here. */
  matcherPairs: number;
  /** Rows beyond the loaded page. */
  hiddenBelow: number;
  onFocus: (entry: OneEntry) => void;
}) {
  const { formatMoney, formatDateShort } = useMoneyFormat();
  const scroll = useRef<ScrollViewInstance>(null);
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
            {queueCounterLabel(queueLeft, answers)}
          </Text>
        </Text>
        <Text style={styles.order}>{t('one.queueOrder')}</Text>
      </View>
      {matcherPairs > 0 ? (
        <Text style={styles.matcherNote}>{t('transfer.paneNote', { count: matcherPairs })}</Text>
      ) : null}
      <ScrollView ref={scroll} style={styles.list} nestedScrollEnabled>
        {filed.map((entry) => {
          const cents = milliToCents(entry.amount);
          return (
            <View key={`filed-${entry.transaction_id}`} style={[styles.row, styles.rowFiled]}>
              <View style={styles.rowText}>
                <Text style={styles.payeeFiled} numberOfLines={1}>
                  {entry.payee ?? t('row.unnamed')}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {formatDateShort(entry.date)} · ✓ {entry.text}
                </Text>
              </View>
              <Text style={styles.amountFiled}>{formatMoney(cents)}</Text>
            </View>
          );
        })}
        {entries.map((entry) => {
          const focused = entry.transaction_id === focusedId;
          const line = paneLine(entry, formatDateShort);
          const cents = milliToCents(line.amount);
          return (
            <Pressable
              key={entry.transaction_id}
              onLayout={track(entry.transaction_id)}
              onPress={() => onFocus(entry)}
              accessibilityRole="button"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={t('one.rowA11y', { payee: line.payee, amount: formatMoney(cents) })}
              style={[styles.row, focused && styles.rowFocused]}>
              <View style={styles.rowText}>
                <Text style={styles.payee} numberOfLines={1}>
                  {line.payee}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {line.subline}
                </Text>
              </View>
              <View style={styles.rowEnd}>
                <Text style={[styles.amount, cents > 0 && styles.in]}>{formatMoney(cents)}</Text>
                {line.confidence !== null ? (
                  <Text style={[styles.percent, { color: BAND_COLOR[confidenceBand(line.confidence)] }]}>
                    {thresholdPercent(line.confidence)}%
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
  matcherNote: {
    color: colors.muted,
    fontSize: 11.5,
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 8,
  },
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
