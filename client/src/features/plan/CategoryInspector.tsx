/**
 * Category inspector (syscd-app-nrg) — YNAB-style right sidebar on desktop,
 * bottom sheet on tablet/phone. Shows the Available Balance breakdown (pure
 * domain math, domain/inspector.ts), the category's funding target (edited
 * inline via InspectorTarget), per-category+month notes, and
 * the move-money / cover-overspending actions.
 */

import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  useApplyAutoAssignMutation,
  useSetCategoryTargetMutation,
  useDeleteCategoryTargetMutation,

  useGetCategoryNotesQuery,
  useSetAssignedMutation,
  useSetCategoryNoteMutation} from '@/budget/data/api';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import { targetFundingState } from '@/domain/engine';
import {
  AVERAGE_STRATEGIES,
  buildAutoAssignSnapshot,
  buildAutoAssignStrategy,
  type AutoAssignSnapshot,
  type AutoAssignStrategyKey,
} from '@/domain/auto-assign';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { availableBreakdown, type BreakdownRow } from '@/domain/inspector';
import { activityFor, type ActivityMap } from '@/domain/people';
import { creditOverspendHint } from '@/domain/overspendHints';
import { useBudgetMonth } from '@/state/useBudgetMonth';
import { categoryFigures } from '@/domain/zeroSum';
import { neededBy } from '@/domain/targets';
import type { Budget, Category, Cents, MonthKey } from '@/domain/types';
import { GhostButton, IndigoButton, MoneyInput, OverlaySheet, Pill } from '@/ui/bits';
import { CategoryPersonField } from './CategoryPersonField';
import { TargetEditor, TargetSummary } from './TargetEditor';
import { useAppDispatch } from '@/state/hooks';
import { makeAssignEdit, newPlanEdit } from '@/state/planEdits';
import { recordPlanEdit } from '@/state/ui';
import { colors, radius } from '@/ui/theme';
import type { MoveMoneyRequest } from './MoveMoneySheet';
import { labels } from '@shared/i18n';
import { t } from './inspector/i18n';

/** Single-category quick-assign snapshot (xvu scope A): the full snapshot (so
 * the engine's figures stay whole-budget) narrowed to one category so
 * target-based rows (Underfunded) can appear. The category's own `target`
 * drives target rows. Shared by the inspector, assign numpad, and mobile
 * detail page. */
export function singleCategorySnap(budget: Budget, category: Category, month: MonthKey): AutoAssignSnapshot {
  const snap = buildAutoAssignSnapshot(budget, month);
  return { ...snap, categories: snap.categories.filter((c) => c.id === category.id) };
}

export const QUICK_ASSIGN_KEYS = [
  'underfunded',
  'assignedLastMonth',
  'spentLastMonth',
  'averageAssigned',
  'averageSpent',
] as const;

const QUICK_ASSIGN_LABELS = labels(t, {
  underfunded: 'quickAssign.underfunded',
  assignedLastMonth: 'quickAssign.assignedLastMonth',
  spentLastMonth: 'quickAssign.spentLastMonth',
  averageAssigned: 'quickAssign.averageAssigned',
  averageSpent: 'quickAssign.averageSpent',
});

/** YNAB's ⚡ Underfunded row shows the missing amount and applies the full
 * needed assignment — every other row shows the applied value itself. */
const GAP_DISPLAY_KEYS: ReadonlySet<AutoAssignStrategyKey> = new Set(['underfunded']);

const BREAKDOWN_LABELS: Record<BreakdownRow['key'], string> = labels(t, {
  carryover: 'breakdown.carryover',
  assigned: 'breakdown.assigned',
  activity: 'breakdown.activity',
  funded: 'breakdown.funded',
  payments: 'breakdown.payments',
});

/** Single-category quick assign (xvu scope A): one strategy row, applied. */
export function buildQuickAssignStrategy(
  snap: AutoAssignSnapshot,
  key: Extract<
    AutoAssignStrategyKey,
    | 'underfunded'
    | 'assignedLastMonth'
    | 'spentLastMonth'
    | 'averageAssigned'
    | 'averageSpent'
  >,
): { assignCents: Cents; displayCents: Cents; label: string; averageMonths: number } | null {
  const strategy = buildAutoAssignStrategy(snap, key);
  const row = strategy.rows.find((r) => r.categoryId === snap.categories[0]?.id);
  if (!row) return null;
  const label = QUICK_ASSIGN_LABELS[key];
  const avg = AVERAGE_STRATEGIES.includes(key) ? strategy.monthsUsed.length : 0;
  return {
    assignCents: row.assignCents,
    // YNAB's Underfunded row shows the missing amount (the delta); the row
    // still applies the full needed assignment.
    displayCents: GAP_DISPLAY_KEYS.has(key) ? row.deltaCents : row.assignCents,
    label,
    averageMonths: avg,
  };
}

/**
 * TARGET section body (syscd-app-1n0s): the shared YNAB-parity TargetEditor
 * inline. The storage row is converted to the domain `CategoryTarget` shape;
 * save errors render inside the editor's own error line.
 */
export function InspectorTarget({
  category,
  budgetId,
  month,
  assigned,
  available,
}: {
  category: Category;
  budgetId: string;
  month: MonthKey;
  /** Engine figures for the month (unified Assigned / Available). */
  assigned: Cents;
  available: Cents;
}) {
  const [setTarget] = useSetCategoryTargetMutation();
  const [removeTarget] = useDeleteCategoryTargetMutation();

  const target = category.target ?? null;
  // Saved targets show the YNAB summary card first (syscd-app-hsjm); the
  // editor opens via "Edit Target" (or straight away when nothing is set).
  const [editing, setEditing] = useState(false);

  if (!target) {
    return (
      <TargetEditor
        target={null}
        onSave={(draft) =>
          setTarget({ budgetId, categoryId: category.id, target: { ...draft, config: { ...draft.config } } })
            .unwrap()
            .then(() => setEditing(false))
        }
      />
    );
  }

  const toggleSnooze = (snooze: boolean) =>
    setTarget({
      budgetId,
      categoryId: category.id,
      target: { kind: target.kind, amountCents: target.amountCents, snoozeMonth: snooze ? month : null, config: { ...target.config } },
    }).unwrap();

  if (!editing) {
    return (
      <TargetSummary
        target={target}
        month={month}
        assigned={assigned}
        available={available}
        onEdit={() => setEditing(true)}
        onToggleSnooze={toggleSnooze}
      />
    );
  }

  return (
    <TargetEditor
      target={target}
      onSave={(draft) =>
        setTarget({ budgetId, categoryId: category.id, target: { ...draft, config: { ...draft.config } } })
          .unwrap()
          .then(() => setEditing(false))
      }
      onDelete={() => removeTarget({ budgetId, categoryId: category.id }).unwrap()}
      onCancel={() => setEditing(false)}
    />
  );
}

/** One quick-assign row: spec label + computed value, applies on tap (xvu scope A).
 * `value` is what the row shows (the gap for Underfunded); `applyCents` is the
 * absolute assignment it commits — they differ only for gap-display rows. */
export function QuickAssignRow({
  budget,
  budgetId,
  month,
  category,
  label,
  value,
  applyCents,
  averageMonths,
  onApplied,
}: {
  budget: Budget;
  budgetId: string;
  month: MonthKey;
  category: Category;
  /** Spec label, e.g. "Spent Last Month". */
  label: string;
  /** Displayed amount (may be the delta for Underfunded). */
  value: Cents;
  /** Absolute assignment committed on tap. */
  applyCents: Cents;
  /** Non-zero shows the "(Nmo avg)" suffix for average strategies. */
  averageMonths: number;
  onApplied: () => void;
}) {
  const { formatMoney } = useMoneyFormat();
  const [applyAutoAssign] = useApplyAutoAssignMutation();
  const dispatch = useAppDispatch();
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    setError(null);
    applyAutoAssign({
      budgetId,
      month,
      rows: [{ categoryId: category.id, assignCents: applyCents }],
    })
      .unwrap()
      .then(() => {
        // Undo snapshot over the pre-mutation aggregate (pattern of recordAssigned).
        const draft = makeAssignEdit(budget, budgetId, month, category.id, applyCents, { formatMoney });
        if (draft) dispatch(recordPlanEdit(newPlanEdit(draft)));
        onApplied();
      })
      .catch((err) => setError(apiErrorMessage(err, t('quickAssign.failed'))));
  };

  const shownLabel = averageMonths > 0 ? t('quickAssign.withAverage', { label, count: averageMonths }) : label;
  return (
    <>
      <Pressable
        style={styles.qaRow}
        accessibilityRole="button"
        accessibilityLabel={t('quickAssign.assignLabel', { amount: formatMoney(applyCents) })}
        onPress={apply}>
        <Text style={styles.qaLabel}>
          {shownLabel}
        </Text>
        <Text style={styles.qaValue}>{formatMoney(value)}</Text>
      </Pressable>
      {error ? <Text style={styles.saveError}>{error}</Text> : null}
    </>
  );
}

/** The five quick-assign rows for one category (detail page + assign numpad). */
export function QuickAssignList({
  budget,
  budgetId,
  month,
  category,
  snap,
  onApplied,
}: {
  budget: Budget;
  budgetId: string;
  month: MonthKey;
  category: Category;
  snap: AutoAssignSnapshot;
  onApplied: () => void;
}) {
  return (
    <>
      {QUICK_ASSIGN_KEYS.map((key) => {
        const q = buildQuickAssignStrategy(snap, key);
        if (!q) return null;
        return (
          <QuickAssignRow
            key={key}
            budget={budget}
            budgetId={budgetId}
            month={month}
            category={category}
            label={q.label}
            value={q.displayCents}
            applyCents={q.assignCents}
            averageMonths={q.averageMonths}
            onApplied={onApplied}
          />
        );
      })}
    </>
  );
}

export function CategoryInspector({
  budgetId,
  month,
  category,
  budget,
  overlay,
  onClose,
  onMoveMoney,
  onAutoAssign,
  activityMap,
  personName,
}: {
  budgetId: string;
  month: MonthKey;
  category: Category;
  /** Full snapshot for quick-assign history math (xvu scope A). */
  budget: Budget;
  /** Bottom sheet on tablet/phone; fixed sidebar panel on desktop. */
  overlay: boolean;
  onClose: () => void;
  onMoveMoney: (req: MoveMoneyRequest) => void;
  /** Link-out to the plan screen's Auto-Assign panel. */
  onAutoAssign: () => void;
  /** Per-person activity map from the Plan's person filter (null = household). */
  activityMap: ActivityMap | null;
  /** Label of the selected person; null when the Plan shows the household. */
  personName: string | null;
}) {
  const { formatMoney } = useMoneyFormat();
  const [setAssigned, assignedMeta] = useSetAssignedMutation();
  const [setNote, noteMeta] = useSetCategoryNoteMutation();
  const notesQuery = useGetCategoryNotesQuery({ budgetId, month });
  const storedNote = notesQuery.data?.find((r) => r.category_id === category.id)?.note ?? '';

  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotesText] = useState(storedNote);
  useEffect(() => {
    if (!editingNotes) setNotesText(storedNote);
  }, [category.id, month, storedNote, editingNotes]);

  const errorSources: [unknown, string][] = [
    [notesQuery.error, t('notes.loadFailed')],
    [noteMeta.error, t('notes.saveFailed')],
    [assignedMeta.error, t('inspector.assignFailed')],
  ];
  const error = errorSources
    .map(([e, fallback]) => (e ? apiErrorMessage(e, fallback) : null))
    .find((msg): msg is string => msg !== null);

  const bm = useBudgetMonth(budget, month);
  const available = availableBreakdown(bm, category.id);
  const funding = targetFundingState(category, bm);
  const creditHint = creditOverspendHint(bm, category.id, { formatMoney });
  const assigned = categoryFigures(bm, category.id).assigned;

  // --- xvu scope A: quick-assign rows from the single-category snapshot ----
  const snap = useMemo(
    () => singleCategorySnap(budget, category, month),
    [budget, category, month],
  );

  // --- collapsible state (xvu scope A) --------------------------------------
  const [openAvail, setOpenAvail] = useState(true);
  const [openTarget, setOpenTarget] = useState(true);
  const [openAuto, setOpenAuto] = useState(true);

  const content = (
    <>
      {!overlay ? (
        <View style={styles.header}>
          <Text style={styles.title}>{category.name}</Text>
          <Pressable onPress={onClose} style={styles.closeBtn} accessibilityLabel={t('inspector.close')}>
            <Text style={{ color: colors.muted, fontSize: 13 }}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      {/* (2) AVAILABLE BALANCE collapsible — rows + total pill in header */}
      <View style={styles.card}>
        <Pressable
          style={styles.sectionHead}
          accessibilityRole="button"
          accessibilityLabel={t('section.availableToggle')}
          onPress={() => setOpenAvail((v) => !v)}>
          <Text style={styles.sectionTitle}>{t('section.availableTitle')}</Text>
          <Pill state={funding.state} cents={available.available} />
        </Pressable>
        {openAvail
          ? available.rows.map((row) => (
              <View key={row.key} style={styles.kvRow}>
                <Text style={styles.kvLabel}>{BREAKDOWN_LABELS[row.key]}</Text>
                {row.key === 'assigned' ? (
                  <MoneyInput
                    cents={assigned}
                    onCommit={(next) =>
                      void setAssigned({
                        budgetId,
                        month,
                        categoryId: category.id,
                        assignedCents: next,
                      })
                    }
                  />
                ) : (
                  <Text style={styles.kvValue}>{formatMoney(row.cents)}</Text>
                )}
              </View>
            ))
          : null}
        {openAvail && personName ? (
          // Outside the breakdown on purpose: the rows above (and Available)
          // stay household values and still sum; this is the filtered slice.
          <View style={styles.kvRow}>
            <Text style={styles.kvLabel}>{t('breakdown.personActivity', { name: personName })}</Text>
            <Text style={styles.kvValue}>{formatMoney(activityFor(bm, category.id, activityMap))}</Text>
          </View>
        ) : null}
        {openAvail && available.kind === 'payment' ? (
          <>
            <View style={styles.kvRow}>
              <Text style={styles.kvLabel}>{t('breakdown.cardDebt')}</Text>
              <Text style={styles.kvValue}>{formatMoney(available.debt ?? 0)}</Text>
            </View>
            {(available.underfunded ?? 0) > 0 ? (
              <View style={styles.kvRow}>
                <Text style={[styles.kvLabel, { color: colors.yellowPillFg }]}>{t('breakdown.underfunded')}</Text>
                <Text style={[styles.kvValue, { color: colors.yellowPillFg }]}>{formatMoney(available.underfunded ?? 0)}</Text>
              </View>
            ) : null}
          </>
        ) : null}
        {openAvail && creditHint ? (
          <Text style={[styles.helpLine, { color: colors.yellowPillFg }]}>{creditHint.detail}</Text>
        ) : null}
        {openAvail ? (
          <Text style={styles.helpLine}>
            {available.kind === 'payment'
              ? t('breakdown.formulaPayment')
              : t('breakdown.formulaCategory')}
          </Text>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={[styles.sectionTitle, { marginBottom: 8 }]}>{t('section.personTitle')}</Text>
        <CategoryPersonField budgetId={budgetId} category={category} />
      </View>

      {/* (3) TARGET collapsible — full editor inline; empty state creates */}
      <View style={styles.card}>
        <Pressable
          style={styles.sectionHead}
          accessibilityRole="button"
          accessibilityLabel={t('section.targetToggle')}
          onPress={() => setOpenTarget((v) => !v)}>
          <Text style={styles.sectionTitle}>{t('section.targetTitle')}</Text>
          {category.target ? <Text style={styles.kvValue}>{formatMoney(neededBy(category.target, month))}</Text> : null}
        </Pressable>
        {openTarget ? <InspectorTarget category={category} budgetId={budgetId} month={month} assigned={assigned} available={available.available} /> : null}
      </View>

      {/* (4) AUTO-ASSIGN collapsible — quick-assign rows (xvu scope A) */}
      <View style={styles.card}>
        <Pressable
          style={styles.sectionHead}
          accessibilityRole="button"
          accessibilityLabel={t('section.autoToggle')}
          onPress={() => setOpenAuto((v) => !v)}>
          <Text style={styles.sectionTitle}>{t('auto.title')}</Text>
        </Pressable>
        {openAuto ? (
          <View style={{ gap: 2 }}>
            <QuickAssignList
              budget={budget}
              budgetId={budgetId}
              month={month}
              category={category}
              snap={snap}
              onApplied={() => undefined}
            />
          </View>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={[styles.kvValue, { fontWeight: '700', marginBottom: 6 }]}>{t('notes.title')}</Text>
        <TextInput
          value={notes}
          onChangeText={setNotesText}
          onFocus={() => setEditingNotes(true)}
          onBlur={() => {
            setEditingNotes(false);
            if (notes !== storedNote) {
              void setNote({ budgetId, month, categoryId: category.id, note: notes });
            }
          }}
          multiline
          placeholder={t('notes.placeholder')}
          placeholderTextColor={colors.faint}
          style={styles.notesInput}
          accessibilityLabel={t('notes.label')}
        />
      </View>

      {available.available < 0 ? (
        <View style={styles.card}>
          <Text
            style={[
              styles.targetText,
              { color: funding.state === 'red' ? colors.redFg : colors.yellowPillFg, marginBottom: 8 },
            ]}>
            {funding.state === 'red'
              ? t('overspent.red', { amount: formatMoney(-available.available) })
              : t('overspent.credit', { amount: formatMoney(-available.available) })}
          </Text>
          <IndigoButton
            label={t('action.cover')}
            onPress={() => onMoveMoney({ from: null, to: category.id, pickFrom: true })}
          />
        </View>
      ) : null}
      {available.available > 0 ? (
        <View style={styles.card}>
          <GhostButton label={t('action.move')} onPress={() => onMoveMoney({ from: category.id })} />
        </View>
      ) : null}

      <View style={styles.card}>
        <GhostButton label={t('action.autoAssign')} onPress={onAutoAssign} />
      </View>

      {error ? (
        <Text style={styles.saveError} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </>
  );

  if (overlay) {
    return (
      <OverlaySheet visible onClose={onClose} title={category.name}>
        <ScrollView style={styles.overlayScroll} contentContainerStyle={{ gap: 0, paddingBottom: 8 }}>
          {content}
        </ScrollView>
      </OverlaySheet>
    );
  }
  return (
    <View style={styles.inspector}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>{content}</ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  inspector: {
    width: 300,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    backgroundColor: colors.card2,
  },
  overlayScroll: { maxHeight: 460 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: 13,
    marginBottom: 12,
  },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    gap: 8,
  },
  kvLabel: { color: colors.muted, fontSize: 13 },
  kvValue: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  // xvu scope A: collapsible section header (chevron + title + trailing value)
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 8,
  },
  sectionTitle: { color: colors.faint, fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  // xvu scope A: target editor
  targetHeading: { color: colors.text, fontSize: 14, fontWeight: '700', marginBottom: 4 },
  targetHelp: { color: colors.muted, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 8 },
  kindChip: {
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card2,
  },
  kindChipActive: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  kindText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  kindTextActive: { color: colors.white },
  helpLine: { color: colors.faint, fontSize: 11, marginTop: 6, lineHeight: 16 },
  targetText: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  targetPress: { alignSelf: 'flex-start', marginTop: 6 },
  targetLink: { color: colors.indigo2, fontSize: 13, fontWeight: '600' },
  notesInput: {
    color: colors.text,
    fontSize: 13,
    minHeight: 60,
    textAlignVertical: 'top',
    padding: 0,
  },
  // xvu scope A: quick-assign rows
  qaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 7,
    borderTopWidth: 1,
    borderTopColor: colors.border2,
  },
  qaLabel: { color: colors.text, fontSize: 13 },
  qaValue: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  saveError: { color: colors.redFg, fontSize: 12 },
});
