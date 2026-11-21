/**
 * DatePickerPopover — YNAB-style month-grid calendar for the register DATE
 * cell (issue syscd-app-r2u). The input keeps its typed DD/MM/YYYY workflow;
 * focusing (or ArrowDown) opens a calendar portal: prev/next month arrows,
 * weekday row Su–Sa, today ring, selected highlight. Picking a day commits
 * the same formatted text a typed date would ("same mutation path"), Esc
 * closes, and a pinned footer slot hosts the Repeat control (syscd-app-x9u).
 */
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useMemo, useState, type ReactNode } from 'react';
import { formatMonthLong, makeMonth, nextMonth, prevMonth, splitMonth, todayIso, weekdayMin } from '@/domain/format';
import { useMoneyFormat } from '../moneyFormat';
import type { MonthKey } from '@/domain/types';
import { colors } from '@/ui/theme';
import { t } from '../text/i18n';
import { DropdownShell, dropdownStyles, pressNoBlur, useDropdownPortal, type DropdownKeyEvent } from './dropdown';

interface DayCell {
  iso: string;
  day: number;
  inMonth: boolean;
}

/** Six-week Sunday-first grid covering `key` (leading/trailing cells may be null for blank padding). */
function buildMonthGrid(key: MonthKey): (DayCell | null)[] {
  const { year, month } = splitMonth(key);
  const first = new Date(year, month - 1, 1);
  const lead = first.getDay(); // 0 = Sunday
  const count = new Date(year, month, 0).getDate();
  const cells: (DayCell | null)[] = [];
  const isoOf = (d: number) =>
    `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let d = 1; d <= count; d += 1) cells.push({ iso: isoOf(d), day: d, inMonth: true });
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function DatePickerPopover({
  value,
  onChangeText,
  onEscape,
  onEnter,
  footer,
  style,
  containerStyle,
  accessibilityLabel,
}: {
  /** Committed DD/MM/YYYY text (the register row's dateText). */
  value: string;
  onChangeText: (text: string) => void;
  /** Escape with the calendar closed (row-level close). */
  onEscape: () => void;
  /** Enter with the calendar closed (row-level save). */
  onEnter: () => void;
  /** Pinned content under the grid — the Repeat control slot (syscd-app-x9u). */
  footer?: ReactNode;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const { formatDate, parseDateInput } = useMoneyFormat();
  const [open, setOpen] = useState(false);
  const [display, setDisplay] = useState<MonthKey>(() => makeMonth(new Date().getFullYear(), new Date().getMonth() + 1));
  const [highlight, setHighlight] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const close = () => setOpen(false);
  const { containerRef, anchor, blurClose } = useDropdownPortal(open, close);

  const today = todayIso();
  const selected = parseDateInput(value);
  const grid = useMemo(() => buildMonthGrid(display), [display]);

  const openCalendar = () => {
    const base = selected ?? today;
    const [y, m] = base.split('-');
    setDisplay(makeMonth(Number(y), Number(m)));
    setHighlight(base);
    setOpen(true);
  };

  const pick = (iso: string | null) => {
    if (!iso) return;
    setOpen(false);
    onChangeText(formatDate(iso));
  };

  const moveHighlight = (from: string, deltaDays: number) => {
    const d = new Date(`${from}T00:00:00`);
    d.setDate(d.getDate() + deltaDays);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const [y, m] = iso.split('-');
    const key = makeMonth(Number(y), Number(m));
    if (key !== display) setDisplay(key);
    setHighlight(iso);
  };

  const onKeyPress = (e: DropdownKeyEvent) => {
    const { key } = e.nativeEvent;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        openCalendar();
        return;
      }
      moveHighlight(highlight ?? selected ?? today, key === 'ArrowDown' ? 7 : -7);
    } else if (open && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      e.preventDefault();
      moveHighlight(highlight ?? selected ?? today, key === 'ArrowLeft' ? -1 : 1);
    } else if (key === 'Enter' && open) {
      e.preventDefault();
      pick(highlight);
    } else if (key === 'Escape') {
      if (open) {
        e.preventDefault();
        close();
      } else {
        onEscape();
      }
    }
  };

  return (
    <View ref={containerRef} style={[styles.cell, containerStyle]}>
      <DropdownShell
        open={open}
        anchor={anchor}
        value={value}
        onChangeText={onChangeText}
        onFocus={openCalendar}
        onBlur={blurClose}
        onKeyPress={onKeyPress}
        placeholder={t('date.placeholder')}
        chevron
        style={style}
        containerStyle={styles.cellInner}
        accessibilityLabel={accessibilityLabel}
        portalMinWidth={252}
        portalMaxHeight={340}
        nativeMaxHeight={400}
        scroll={false}
        footer={footer}
      >
        <View style={styles.cal}>
          <View style={styles.calHeader}>
            <Pressable
              onPress={() => setDisplay(prevMonth(display))}
              {...pressNoBlur}
              accessibilityLabel={t('date.previousMonth')}>
              <Text style={styles.calArrow}>‹</Text>
            </Pressable>
            <Text style={styles.calTitle}>{formatMonthLong(display)}</Text>
            <Pressable
              onPress={() => setDisplay(nextMonth(display))}
              {...pressNoBlur}
              accessibilityLabel={t('date.nextMonth')}>
              <Text style={styles.calArrow}>›</Text>
            </Pressable>
          </View>
          <View style={styles.calWeekRow}>
            {[0, 1, 2, 3, 4, 5, 6].map((d) => (
              <Text key={d} style={styles.calWeekday}>
                {weekdayMin(d)}
              </Text>
            ))}
          </View>
          {[0, 1, 2, 3, 4, 5].map((week) => (
            <View key={week} style={styles.calWeekRow}>
              {grid.slice(week * 7, week * 7 + 7).map((cell, i) => {
                if (!cell) return <View key={`blank-${i}`} style={styles.dayCell} />;
                const isSelected = cell.iso === selected;
                const isToday = cell.iso === today;
                const isHighlight = cell.iso === highlight;
                return (
                  <Pressable
                    key={cell.iso}
                    onPress={() => pick(cell.iso)}
                    onHoverIn={() => setHovered(cell.iso)}
                    onHoverOut={() => setHovered(null)}
                    accessibilityLabel={t('date.day', { day: cell.day })}
                    style={[
                      styles.dayCell,
                      isHighlight && dropdownStyles.rowActive,
                      hovered === cell.iso && !isHighlight && dropdownStyles.rowActive,
                    ]}>
                    <Text
                      style={[
                        styles.dayText,
                        !cell.inMonth && styles.dayOutside,
                        isToday && styles.dayToday,
                        isSelected && styles.daySelected,
                      ]}>
                      {cell.day}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </DropdownShell>
    </View>
  );
}

const styles = StyleSheet.create({
  cell: { position: 'relative', zIndex: 30 },
  cellInner: { position: 'relative' },
  cal: { padding: 8 },
  calHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
    paddingBottom: 4,
  },
  calArrow: { color: colors.text, fontSize: 16, paddingHorizontal: 8, fontWeight: '600' },
  calTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  calWeekRow: { flexDirection: 'row' },
  calWeekday: { width: 34, color: colors.faint, fontSize: 10, fontWeight: '700', textAlign: 'center', paddingVertical: 2 },
  dayCell: {
    width: 34,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  dayText: { color: colors.text, fontSize: 12 },
  dayOutside: { color: colors.faint },
  dayToday: {
    borderWidth: 1,
    borderColor: colors.indigo2,
    borderRadius: 6,
    width: 24,
    height: 22,
    lineHeight: 20,
    textAlign: 'center',
  },
  daySelected: {
    backgroundColor: colors.indigo,
    color: colors.white,
    borderRadius: 6,
    width: 24,
    height: 22,
    lineHeight: 22,
    textAlign: 'center',
    overflow: 'hidden',
    fontWeight: '700',
  },
});
