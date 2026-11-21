/**
 * Mobile assign numpad (YNAB mobile parity) — the bottom panel that opens when
 * a plan row is tapped on phone: an options row (Auto-Assign ⚡ / Move Money →
 * / Details …), the underfunded hint banner with a snooze toggle
 * (syscd-app-hsjm), and a calculator numpad that edits the row's ASSIGNED
 * amount live. The keypad is a pure state machine (domain/quickmath.ts,
 * syscd-app-m1hr); its state lives in PlanScreen so the row's ASSIGNED cell
 * renders the live equation while typing — the panel itself shows no value.
 *
 * Non-modal (T3, syscd-app-qitk): no RN Modal and no backdrop — an absolutely
 * positioned bottom overlay with `pointerEvents="box-none"`, so the plan list
 * beneath stays fully interactive (scroll works while open; tapping another
 * row switches the editor, tapping the open row closes the panel). PlanScreen
 * scrolls the tapped row directly above the panel via `panelRef`.
 */

import { useMemo, useState, type Ref } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ViewInstance } from 'react-native';


import { apiErrorMessage } from '@/platform/api/baseQuery';

import { useSetCategoryTargetMutation } from '@/budget/data/api';
import { categoryLabel } from '@/domain/bundles';
import { assignedInMonth } from '@/domain/engine';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { resolve, type NumpadKey, type NumpadState } from '@/domain/quickmath';
import { neededBy } from '@/domain/targets';
import type { Budget, Category, CategoryTarget, MonthKey } from '@/domain/types';
import { colors, radius } from '@/ui/theme';
import { QuickAssignList, singleCategorySnap } from './CategoryInspector';
import { t } from './mobile/i18n';

/** Bottom keypad rows (YNAB mobile: 789− 456+ 123= ✕0⌫✓). */
const KEY_ROWS = [
  ['7', '8', '9', '−'],
  ['4', '5', '6', '+'],
  ['1', '2', '3', '='],
  ['close', '0', 'del', 'done'],
] as const;

/** Everything the sheet renders — the engine's NumpadKey excludes the
 * UI-only keys: 'close' (✕) dismisses the panel and 'done' (✓) commits. */
type PadKey = NumpadKey | 'close' | 'done';

export function MobileAssignNumpad({
  onClose,
  budget,
  budgetId,
  month,
  category,
  state,
  onKey,
  onMoveMoney,
  onMoreDetails,
  recordAssigned,
  panelRef,
}: {
  onClose: () => void;
  budget: Budget;
  budgetId: string;
  month: MonthKey;
  category: Category;
  /** Numpad state owned by PlanScreen — the row's ASSIGNED cell renders it
   * live, so the sheet itself shows no value. */
  state: NumpadState;
  /** Apply one keypad press through the engine (applyNumpadKey). */
  onKey: (key: NumpadKey) => void;
  /** Open the move-money flow for this category. */
  onMoveMoney: () => void;
  /** Open the full-screen category detail page. */
  onMoreDetails: () => void;
  /** Commit the keypad value as the row's assigned amount (with undo). */
  recordAssigned: (categoryId: string, cents: number) => void;
  /** Ref to the panel's outer View (popover + sheet): its top edge is the
   * alignment target — PlanScreen scrolls the tapped row directly above it. */
  panelRef?: Ref<ViewInstance>;
}) {
  const { formatMoney } = useMoneyFormat();
  const [pop, setPop] = useState<'auto' | null>(null);
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  const [setCategoryTarget] = useSetCategoryTargetMutation();

  const assigned = assignedInMonth(category, month);
  const target: CategoryTarget | null = category.target ?? null;
  const snap = useMemo(
    () => singleCategorySnap(budget, category, month),
    [budget, category, month],
  );

  const more = target ? Math.max(0, neededBy(target, month) - assigned) : 0;

  const press = (key: PadKey) => {
    if (key === 'close') {
      // ✕ dismisses the panel, discarding the pending draft (same as tapping
      // the open row again).
      onClose();
      return;
    }
    if (key === 'done') {
      // ✓ commits resolve(state): pristine resolves to null and keeps the
      // row's current value — nothing is written.
      const value = resolve(state);
      onClose();
      if (value !== null && value !== assigned) recordAssigned(category.id, value);
      return;
    }
    onKey(key);
  };

  const toggleSnooze = () => {
    if (!target) return;
    setSnoozeError(null);
    setCategoryTarget({
      budgetId,
      categoryId: category.id,
      target: {
        kind: target.kind,
        amountCents: target.amountCents,
        snoozeMonth: target.snoozeMonth === month ? null : month,
        config: { ...target.config },
      },
    })
      .unwrap()
      .catch((err) => setSnoozeError(apiErrorMessage(err, t('numpad.snoozeFailed'))));
  };

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {/* Panel root spans popover + sheet: its top edge is the alignment
          target — PlanScreen scrolls the tapped row directly above it. */}
      <View ref={panelRef} pointerEvents="box-none">
        {pop === 'auto' ? (
          <View style={styles.popCard}>
            <Text style={styles.popTitle}>{t('numpad.autoAssignTitle')}</Text>
            <ScrollView style={styles.popScroll} nestedScrollEnabled>
              <QuickAssignList
                budget={budget}
                budgetId={budgetId}
                month={month}
                category={category}
                snap={snap}
                onApplied={onClose}
              />
            </ScrollView>
          </View>
        ) : null}
        <View style={styles.sheet}>
          {/* Bundled category: breadcrumb so it is clear which bundle's row is being edited. */}
          {category.bundleId ? (
            <Text style={styles.crumb} numberOfLines={1} accessibilityLabel={t('numpad.categoryLabel')}>
              {categoryLabel(category, budget.bundles)}
            </Text>
          ) : null}
          {/* No value display here on purpose: the live equation lives in
          the row's ASSIGNED cell behind this panel. */}
          <View style={styles.optionsRow}>
            <View style={styles.option}>
              <Pressable
                style={styles.optionBtn}
                accessibilityRole="button"
                accessibilityLabel={t('numpad.autoAssignFor', { name: category.name })}
                onPress={() => setPop((prev) => (prev === 'auto' ? null : 'auto'))}>
                <Text style={styles.optionGlyph}>⚡</Text>
              </Pressable>
              <Text style={styles.optionLabel}>{t('numpad.option.autoAssign')}</Text>
            </View>
            <View style={styles.option}>
              <Pressable
                style={styles.optionBtn}
                accessibilityRole="button"
                accessibilityLabel={t('numpad.moveFrom', { name: category.name })}
                onPress={onMoveMoney}>
                <Text style={styles.optionGlyph}>→</Text>
              </Pressable>
              <Text style={styles.optionLabel}>{t('numpad.option.moveMoney')}</Text>
            </View>
            <View style={styles.option}>
              <Pressable
                style={styles.optionBtn}
                accessibilityRole="button"
                accessibilityLabel={t('numpad.detailsFor', { name: category.name })}
                onPress={onMoreDetails}>
                <Text style={styles.optionGlyph}>…</Text>
              </Pressable>
              <Text style={styles.optionLabel}>{t('numpad.option.details')}</Text>
            </View>
          </View>
          {snoozeError ? <Text style={styles.errorText}>{snoozeError}</Text> : null}
          {target && more > 0 ? (
            <View style={styles.hintRow}>
              <View style={styles.hintBanner}>
                <Text style={styles.hintText}>{t('numpad.hint', { amount: formatMoney(more) })}</Text>
              </View>
              <Pressable
                style={styles.snoozeBtn}
                accessibilityRole="button"
                accessibilityLabel={t('numpad.snoozeFor', { name: category.name })}
                onPress={toggleSnooze}>
                {/* eslint-disable-next-line budget-i18n/no-untranslated-string -- "zZ" sleep glyph, not a word */}
                <Text style={styles.snoozeText}>z<Text style={styles.snoozeSup}>Z</Text></Text>
              </Pressable>
            </View>
          ) : null}
          {pop === 'auto' ? null : (
            <View>
              {KEY_ROWS.map((row, rowIndex) => (
                <View key={rowIndex} style={styles.padRow}>
                  {row.map((key) => {
                    if (key === 'close') {
                      return (
                        <Pressable key={key} style={styles.key} onPress={() => press(key)}>
                          <View style={styles.closeDisc}>
                            <Text style={styles.closeGlyph}>✕</Text>
                          </View>
                        </Pressable>
                      );
                    }
                    if (key === 'del') {
                      return (
                        <Pressable key={key} style={styles.key} onPress={() => press(key)}>
                          <Text style={styles.delGlyph}>⌫</Text>
                        </Pressable>
                      );
                    }
                    if (key === 'done') {
                      return (
                        <Pressable key={key} style={styles.key} onPress={() => press(key)}>
                          <View style={styles.donePill}>
                            <Text style={styles.doneGlyph}>✓</Text>
                          </View>
                        </Pressable>
                      );
                    }
                    const isOp = key === '−' || key === '+' || key === '=';
                    return (
                      <Pressable key={key} style={styles.key} onPress={() => press(key)}>
                        <Text style={isOp ? styles.opGlyph : styles.digitGlyph}>{key}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Bottom panel overlay (T3, syscd-app-qitk): fills the window but is
  // transparent and box-none — touches land on the plan list beneath except
  // on the popover/sheet themselves (which stay interactive).
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end' },
  // Auto-assign popover floats above the sheet, in the keypad's place.
  popCard: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card2,
    padding: 12,
    gap: 8,
  },
  popTitle: { color: colors.faint, fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  popScroll: { maxHeight: 130 },
  crumb: { color: colors.muted, fontSize: 12, fontWeight: '700', textAlign: 'center', paddingBottom: 6 },
  sheet: {
    backgroundColor: colors.card2,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  optionsRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  option: { flex: 1, alignItems: 'center', gap: 6 },
  optionBtn: {
    alignSelf: 'stretch',
    height: 46,
    borderRadius: radius.pill,
    backgroundColor: colors.border2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionGlyph: { color: colors.text, fontSize: 20 },
  optionLabel: { color: colors.text, fontSize: 13, fontWeight: '600' },
  hintRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 12 },
  hintBanner: {
    flex: 1,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.indigoSoft,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  hintText: { color: colors.indigo3, fontSize: 14, fontWeight: '600' },
  snoozeBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.border2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  snoozeText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  snoozeSup: { fontSize: 9 },
  // Keypad sized so options + hint + keypad stay ≤ ~40% of the phone
  // viewport (T3, syscd-app-qitk): 4×46 keys ≈ 184px of panel height.
  padRow: { flexDirection: 'row' },
  key: { flex: 1, height: 46, alignItems: 'center', justifyContent: 'center' },
  digitGlyph: { color: colors.text, fontSize: 22 },
  opGlyph: { color: colors.indigo2, fontSize: 24, fontWeight: '600' },
  closeDisc: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.border2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeGlyph: { color: colors.text, fontSize: 12, fontWeight: '700' },
  delGlyph: { color: colors.text, fontSize: 20 },
  donePill: {
    width: 44,
    height: 30,
    borderRadius: 10,
    backgroundColor: colors.indigo2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneGlyph: { color: colors.text, fontSize: 15, fontWeight: '700' },
  errorText: { color: colors.redFg, fontSize: 12, marginBottom: 8 },
});
