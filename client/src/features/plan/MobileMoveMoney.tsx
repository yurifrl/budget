/**
 * Mobile move-money flow (YNAB mobile parity) — single full-screen page that
 * replaces the OverlaySheet on phone. Directional model: one focus category
 * (or Ready to Assign) plus a From/To toggle deciding whether the focus
 * GIVES money ("Move From X" — distribute across destination rows) or
 * RECEIVES it ("Move To X" — gather from source rows). Rows are added via
 * "+ Select Another" and sized with drag sliders; the direction seeds
 * smartly from the entry (overspent pill → To, positive pill → From,
 * RTA banner → To Ready to Assign with the toggle hidden). All math,
 * validation and persistence come from the shared `useMoveMoney` hook —
 * this file is UI only.
 */

import { Fragment, useMemo, useRef, useState } from 'react';
import { Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { MovePair } from '@/budget/data/ledger';
import { categoryLabel } from '@/domain/bundles';
import { categoryFigures } from '@/domain/zeroSum';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { neededBy } from '@/domain/targets';
import type { Budget, Cents, MonthKey } from '@/domain/types';
import { Pill } from '@/ui/bits';
import { buildCategoryPickItems, type CategoryPickItem } from '@/ui/categoryPick';
import { centsPillState, colors, radius } from '@/ui/theme';
import { useMoveMoney, type MoveMoneyRequest } from './MoveMoneySheet';

/** One counterpart row: null = Ready to Assign. */
interface MoveRow {
  categoryId: string | null;
  amount: Cents;
}

type Direction = 'from' | 'to';

/** Drag slider for a row amount (whole-currency steps, 1-cent for tiny maxima). */
function MoveSlider({
  value,
  max,
  accent,
  label,
  onChange,
}: {
  value: Cents;
  max: Cents;
  accent: string;
  label: string;
  onChange: (next: Cents) => void;
}) {
  const widthRef = useRef(0);
  const [width, setWidth] = useState(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => max > 0,
        onMoveShouldSetPanResponder: () => max > 0,
        onPanResponderGrant: (e) => {
          const w = widthRef.current;
          if (max <= 0 || w <= 0) return;
          const frac = Math.min(1, Math.max(0, e.nativeEvent.locationX / w));
          const step = max >= 100 ? 100 : 1;
          onChangeRef.current(Math.min(max, Math.round((frac * max) / step) * step));
        },
        onPanResponderMove: (e) => {
          const w = widthRef.current;
          if (max <= 0 || w <= 0) return;
          const frac = Math.min(1, Math.max(0, e.nativeEvent.locationX / w));
          const step = max >= 100 ? 100 : 1;
          onChangeRef.current(Math.min(max, Math.round((frac * max) / step) * step));
        },
      }),
    [max],
  );

  const frac = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <View
      style={[slider.wrap, max <= 0 && slider.wrapDead]}
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
        setWidth(e.nativeEvent.layout.width);
      }}
      {...pan.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max, now: value }}>
      <View style={slider.track} />
      <View style={[slider.fill, { width: frac * width, backgroundColor: accent }]} />
      <View
        style={[
          slider.knob,
          { left: Math.min(Math.max(0, frac * width - 11), Math.max(0, width - 22)), borderColor: accent },
        ]}
      />
    </View>
  );
}

export function MobileMoveMoney({
  visible,
  onClose,
  budget,
  budgetId,
  month,
  request,
}: {
  visible: boolean;
  onClose: () => void;
  budget: Budget;
  budgetId: string;
  month: MonthKey;
  request: MoveMoneyRequest;
}) {
  const { formatMoney } = useMoneyFormat();
  const insets = useSafeAreaInsets();
  const m = useMoveMoney({ budget, budgetId, month, request, onClose });
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);

  // Focus derived from the request: the entry category, or RTA (null) for the banner.
  const focusId: string | null = request.unassign === true ? null : (request.pickFrom === true ? request.to ?? null : request.from);
  const focusCat = focusId ? (budget.categories.find((c) => c.id === focusId) ?? null) : null;
  const focusLabel = (focusCat ? categoryLabel(focusCat, budget.bundles) : null) ?? 'Ready to Assign';

  // Target awareness (targets are the plan grid's funding targets): the focus
  // has a need when it is overspent, under its target, or RTA-come-negative.
  // Under-target and overspent opens gather-mode; no need distributes instead.
  const focusAvail = focusCat ? categoryFigures(m.bm, focusCat.id).available : 0;
  const focusAssigned = focusCat ? categoryFigures(m.bm, focusCat.id).assigned : 0;
  const focusTarget = focusCat?.target ?? null;
  const targetGap = focusTarget ? Math.max(0, neededBy(focusTarget, month) - focusAssigned) : 0;
  // What the focus is short of: overspending, target gap, or RTA deficit.
  const need: Cents = Math.max(0, -focusAvail) > 0
    ? Math.max(0, -focusAvail)
    : targetGap;

  // Direction seeds from the entry: cover (pickFrom), the RTA banner, and any
  // focus with a need gather INTO the focus; a plain move distributes FROM it.
  // Rows reset on flip.
  const [direction, setDirection] = useState<Direction>(
    request.pickFrom === true || need > 0 ? 'to' : 'from',
  );
  const [rows, setRows] = useState<MoveRow[]>([]);
  const toggleAllowed = focusId !== null;
  const dir: Direction = toggleAllowed ? direction : 'to';
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const bad = dir === 'to' && focusCat != null && focusAvail < 0;
  const accent = bad ? colors.redFg : colors.indigo2;

  // Caps: 'from' rows share the focus balance; 'to' rows are capped by their
  // own source (RTA source capped by Ready to Assign itself).
  const rowMax = (row: MoveRow, index: number): Cents => {
    if (dir === 'from') {
      const others = rows.reduce((sum, r, i) => (i === index ? sum : sum + r.amount), 0);
      return Math.max(0, focusAvail - others);
    }
    if (row.categoryId === null) return Math.max(0, m.readyToAssign);
    const cat = budget.categories.find((c) => c.id === row.categoryId);
    return cat ? Math.max(0, categoryFigures(m.bm, cat.id).available) : 0;
  };

  const addRow = (categoryId: string | null) => {
    // 'to' auto-fills the remaining need from the new source (capped by the
    // source's own available); 'from' adds every row at zero so the user
    // sizes each move themselves — the focus balance only caps, never presets.
    const sourceCap =
      categoryId === null
        ? Math.max(0, m.readyToAssign)
        : Math.max(0, categoryFigures(m.bm, categoryId).available);
    const amount =
      dir === 'to'
        ? Math.min(sourceCap, Math.max(0, need - total))
        : 0;
    setRows([...rows, { categoryId, amount }]);
    setPicking(false);
    setQuery('');
  };

  const setRowAmount = (index: number, amount: Cents) =>
    setRows(rows.map((r, i) => (i === index ? { ...r, amount } : r)));
  const removeRow = (index: number) => setRows(rows.filter((_, i) => i !== index));

  const confirm = () => {
    const pairs: MovePair[] = rows
      .filter((r) => r.amount > 0)
      .map((r) =>
        dir === 'from'
          ? { from: focusId, to: r.categoryId, amount: r.amount }
          : { from: r.categoryId, to: focusId, amount: r.amount },
      );
    void m.confirmPairs(pairs);
  };

  // Picker: categories minus the focus minus already-added rows; RTA appears
  // as a destination ('from') or a source with money ('to'), never as both
  // sides of an RTA focus.
  const rowIds = new Set(rows.map((r) => r.categoryId));
  const rtaEligible = focusId !== null && (dir === 'from' || m.readyToAssign > 0) && !rowIds.has(null);
  const items = useMemo<CategoryPickItem[]>(
    () =>
      buildCategoryPickItems({
        categories: budget.categories,
        groups: budget.groups,
        bundles: budget.bundles,
        query,
        excludeId: focusId,
        selectedId: undefined,
        rta: rtaEligible,
        excludeHidden: true,
      }).filter((item) => item.categoryId === null || !rowIds.has(item.categoryId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [budget, focusId, rtaEligible, query, rows],
  );

  const title = `Move ${dir === 'to' ? 'To' : 'From'} ${focusLabel}`;
  const context =
    dir === 'to'
      ? focusCat == null
        ? `Back to Ready to Assign${m.readyToAssign < 0 ? ` · needs ${formatMoney(-m.readyToAssign)}` : ''}`
        : bad
          ? `Needs ${formatMoney(need)} to cover overspending`
          : targetGap > 0
            ? `Needs ${formatMoney(targetGap)} to reach target`
            : `To ${focusLabel}`
      : `${focusLabel} · ${formatMoney(focusAvail)} available`;
  const verb = request.pickFrom === true ? 'Cover' : dir === 'to' && focusId === null ? 'Remove' : 'Move';
  const canConfirm = total > 0 && !m.applyState.isLoading;

  const back = () => (picking ? setPicking(false) : onClose());

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={back}>
      <View style={[styles.root, { paddingTop: insets.top + 4, paddingBottom: insets.bottom + 10 }]}>
        {/* slim header — back leaves the picker first, then the flow */}
        <View style={[styles.header, bad && styles.headerBad]}>
          <Pressable onPress={back} style={styles.backBtn} accessibilityLabel="Back" accessibilityRole="button">
            <Text style={[styles.backText, bad && styles.headerBadText]}>‹</Text>
          </Pressable>
          <Text style={[styles.title, bad && styles.headerBadText]} numberOfLines={1}>
            {title}
          </Text>
        </View>

        {/* direction toggle + hero total */}
        <View style={styles.hero}>
          {toggleAllowed ? (
            <View style={styles.seg}>
              <Pressable
                style={[styles.segBtn, dir === 'from' && styles.segBtnOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: dir === 'from' }}
                onPress={() => {
                  setDirection('from');
                  setRows([]);
                }}>
                <Text style={[styles.segText, dir === 'from' && styles.segTextOn]}>From</Text>
              </Pressable>
              <Pressable
                style={[styles.segBtn, dir === 'to' && styles.segBtnOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: dir === 'to' }}
                onPress={() => {
                  setDirection('to');
                  setRows([]);
                }}>
                <Text style={[styles.segText, dir === 'to' && styles.segTextOn]}>To</Text>
              </Pressable>
            </View>
          ) : null}
          <Text style={[styles.total, bad && styles.headerBadText]}>{formatMoney(total)}</Text>
          <Text style={[styles.context, bad && styles.headerBadText]}>{context}</Text>
        </View>

        {picking ? (
          <>
            <View style={styles.pickHead}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search…"
                placeholderTextColor={colors.faint}
                style={styles.search}
                accessibilityLabel="Search categories"
                autoFocus
              />
            </View>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: 8 }}
              keyboardShouldPersistTaps="handled">
              {items.map((item, i) => {
                const cat = item.categoryId
                  ? (budget.categories.find((c) => c.id === item.categoryId) ?? null)
                  : null;
                const avail = cat ? categoryFigures(m.bm, cat.id).available : m.readyToAssign;
                return (
                  <Fragment key={item.key}>
                    {item.groupTitle !== undefined && (i === 0 || items[i - 1].groupTitle !== item.groupTitle) ? (
                      <Text style={styles.groupHead}>{item.groupTitle}</Text>
                    ) : null}
                    <Pressable
                      style={styles.row}
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${item.label}`}
                      onPress={() => addRow(item.categoryId)}>
                      <Text style={styles.rowLabel} numberOfLines={1}>
                        {item.label}
                      </Text>
                      <Pill state={centsPillState(avail)} cents={avail} small />
                    </Pressable>
                  </Fragment>
                );
              })}
            </ScrollView>
          </>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
            {rows.map((row, i) => {
              const cat = row.categoryId
                ? (budget.categories.find((c) => c.id === row.categoryId) ?? null)
                : null;
              const label = (cat ? categoryLabel(cat, budget.bundles) : null) ?? 'Ready to Assign';
              const avail = cat ? categoryFigures(m.bm, cat.id).available : m.readyToAssign;
              return (
                <View key={row.categoryId ?? '__rta__'} style={[styles.rowCard, bad && styles.rowCardBad]}>
                  <View style={styles.rowTop}>
                    <Text style={styles.rowCardLabel} numberOfLines={1}>
                      {label}
                    </Text>
                    <Pill state={centsPillState(avail)} cents={avail} small />
                    <Pressable
                      onPress={() => removeRow(i)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${label}`}
                      hitSlop={8}>
                      <Text style={styles.rowRemove}>×</Text>
                    </Pressable>
                  </View>
                  <View style={styles.rowBottom}>
                    <MoveSlider
                      value={row.amount}
                      max={rowMax(row, i)}
                      accent={accent}
                      label={`${label} amount`}
                      onChange={(next) => setRowAmount(i, next)}
                    />
                    <Text style={[styles.rowAmount, row.amount === 0 && styles.rowAmountZero]}>
                      {formatMoney(row.amount)}
                    </Text>
                  </View>
                </View>
              );
            })}
            <Pressable style={styles.addBtn} accessibilityRole="button" onPress={() => setPicking(true)}>
              <Text style={styles.addBtnText}>+ Select Another</Text>
            </Pressable>
          </ScrollView>
        )}

        {/* confirm — the button itself carries the total */}
        <View style={styles.footer}>
          <Pressable
            style={[styles.confirmBtn, !canConfirm && styles.confirmBtnDim]}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canConfirm }}
            onPress={canConfirm ? confirm : undefined}>
            <Text style={styles.confirmBtnText}>
              {verb} {formatMoney(total)} ›
            </Text>
          </Pressable>
          {m.confirmError ? (
            <Text style={styles.confirmError} accessibilityRole="alert">
              {m.confirmError}
            </Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const slider = StyleSheet.create({
  wrap: { flex: 1, height: 30, justifyContent: 'center' },
  wrapDead: { opacity: 0.3 },
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
  },
  fill: { position: 'absolute', left: 0, height: 6, borderRadius: 3 },
  knob: {
    position: 'absolute',
    top: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.card,
    borderWidth: 2,
  },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerBad: { borderBottomColor: colors.redPillBg },
  headerBadText: { color: colors.redFg },
  backBtn: { width: 36 },
  backText: { color: colors.text, fontSize: 28, lineHeight: 32, marginTop: -3 },
  title: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '800' },

  hero: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, alignItems: 'center' },
  seg: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radius.r,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  segBtn: { paddingVertical: 7, paddingHorizontal: 22 },
  segBtnOn: { backgroundColor: colors.indigoSoft },
  segText: { color: colors.faint, fontSize: 13, fontWeight: '700' },
  segTextOn: { color: colors.indigo3 },
  total: { color: colors.text, fontSize: 34, fontWeight: '800', marginTop: 6 },
  context: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: 4 },

  pickHead: { paddingHorizontal: 12, paddingBottom: 6 },
  search: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.r,
    color: colors.text,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  groupHead: {
    color: colors.faint,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 3,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  rowLabel: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },

  rowCard: {
    marginHorizontal: 12,
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.card,
    borderRadius: radius.r,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  },
  rowCardBad: { borderColor: colors.redPillBg },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowCardLabel: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '700' },
  rowRemove: { color: colors.faint, fontSize: 20, lineHeight: 22, paddingHorizontal: 2 },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowAmount: { color: colors.text, fontSize: 13, fontWeight: '700', width: 84, textAlign: 'right' },
  rowAmountZero: { color: colors.faint },

  addBtn: {
    marginHorizontal: 12,
    marginTop: 10,
    paddingVertical: 11,
    borderRadius: radius.r,
    borderWidth: 1,
    borderColor: colors.border2,
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  addBtnText: { color: colors.indigo3, fontSize: 14, fontWeight: '700' },

  footer: { paddingHorizontal: 12, paddingTop: 6 },
  confirmBtn: {
    backgroundColor: colors.indigo,
    borderRadius: radius.r,
    alignItems: 'center',
    paddingVertical: 13,
  },
  confirmBtnDim: { opacity: 0.4 },
  confirmBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  confirmError: { color: colors.redFg, fontSize: 12, marginTop: 8, textAlign: 'center' },
});
