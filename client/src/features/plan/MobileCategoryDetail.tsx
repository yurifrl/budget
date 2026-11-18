/**
 * Mobile category detail (YNAB mobile parity) — full-screen page that replaces
 * the bottom-sheet inspector on phone. Big tappable assigned amount, the
 * overspending warning with a cover action, the balance breakdown labeled with
 * month names, quick-assign rows, the shared target block, and the category
 * actions (rename / hide / delete / add transaction). Reuses the inspector's
 * QuickAssignRow + InspectorTarget so the assign/target logic stays single-sourced.
 */

import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import {
  useDeleteCategoryMutation,
  useRenameCategoryMutation,
  useSetAssignedMutation,
  useSetCategoryHiddenMutation,
} from '@/budget/data/api';
import { targetFundingState } from '@/domain/engine';
import { formatMonthLong, prevMonth } from '@/domain/format';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { availableBreakdown } from '@/domain/inspector';
import { activityFor, type ActivityMap } from '@/domain/people';
import { creditOverspendHint } from '@/domain/overspendHints';
import { useBudgetMonth } from '@/state/useBudgetMonth';
import { categoryFigures } from '@/domain/zeroSum';
import type { Budget, Category, MonthKey } from '@/domain/types';
import { BigMoneyInput } from '@/ui/bits';
import { colors, pillColors, radius } from '@/ui/theme';
import { CategoryPersonField } from './CategoryPersonField';
import { InspectorTarget, QuickAssignList, singleCategorySnap } from './CategoryInspector';
import type { MoveMoneyRequest } from './MoveMoneySheet';
import { useBudgetShell } from '@/shell/context';

function ActionRow({
  label,
  danger = false,
  onPress,
}: {
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.actionRow} accessibilityRole="button" onPress={onPress}>
      <Text style={[styles.actionLabel, danger && { color: colors.redFg }]}>{label}</Text>
      <Text style={[styles.actionChevron, danger && { color: colors.redFg }]}>›</Text>
    </Pressable>
  );
}

export function MobileCategoryDetail({
  visible,
  onClose,
  budget,
  budgetId,
  month,
  category,
  activityMap,
  personName,
  onMoveMoney,
}: {
  visible: boolean;
  onClose: () => void;
  budget: Budget;
  budgetId: string;
  month: MonthKey;
  category: Category;
  /** Per-person activity map from the Plan's person filter (null = household). */
  activityMap: ActivityMap | null;
  /** Label of the selected person; null when the Plan shows the household. */
  personName: string | null;
  onMoveMoney: (req: MoveMoneyRequest) => void;
}) {
  const { formatMoney } = useMoneyFormat();
  const insets = useSafeAreaInsets();
  const shell = useBudgetShell();
  const [setAssigned] = useSetAssignedMutation();
  const [renameCategory] = useRenameCategoryMutation();
  const [deleteCategory] = useDeleteCategoryMutation();
  const [setCategoryHidden] = useSetCategoryHiddenMutation();

  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(category.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const bm = useBudgetMonth(budget, month);
  const available = availableBreakdown(bm, category.id);
  const funding = targetFundingState(category, bm);
  const creditHint = creditOverspendHint(bm, category.id, { formatMoney });
  const { assigned, activity } = categoryFigures(bm, category.id);
  const overspent = available.available < 0;
  const spent = activity < 0 ? -activity : 0;

  const snap = useMemo(
    () => singleCategorySnap(budget, category, month),
    [budget, category, month],
  );

  const fail = (err: unknown, fallback: string) => setActionError(apiErrorMessage(err, fallback));

  const commitRename = () => {
    setRenaming(false);
    const next = renameDraft.trim();
    if (next && next !== category.name) {
      renameCategory({ budgetId, categoryId: category.id, name: next }).unwrap().catch((e) => fail(e, 'failed to rename'));
    }
  };

  const hide = () =>
    setCategoryHidden({ budgetId, categoryId: category.id, hidden: true })
      .unwrap()
      .then(onClose)
      .catch((e) => fail(e, 'failed to hide'));

  const doDelete = () =>
    deleteCategory({ budgetId, categoryId: category.id })
      .unwrap()
      .then(onClose)
      .catch((e) => fail(e, 'failed to delete'));

  const addTransaction = () => {
    onClose();
    shell.openAddTransaction({ categoryId: category.id });
  };

  const monthLong = formatMonthLong(month);
  const availColors = pillColors(funding.state);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top + 4, paddingBottom: insets.bottom + 12 }]}>
        {/* header: back + name (tap name to rename) */}
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.backBtn} accessibilityLabel="Back to budget" accessibilityRole="button">
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          {renaming ? (
            <TextInput
              value={renameDraft}
              onChangeText={setRenameDraft}
              autoFocus
              onSubmitEditing={commitRename}
              onBlur={commitRename}
              style={styles.renameInput}
              accessibilityLabel="Category name"
            />
          ) : (
            <Text style={styles.title} numberOfLines={1}>
              {category.name}
            </Text>
          )}
          {/* spacer keeps the title optically centered against the back button */}
          <View style={styles.backBtn} />
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          {/* assigned hero — the amount is the editor */}
          <View style={styles.hero}>
            <BigMoneyInput
              cents={assigned}
              onCommit={(next) => void setAssigned({ budgetId, month, categoryId: category.id, assignedCents: next })}
              accessibilityLabel={`Assigned in ${monthLong}`}
            />
            <Text style={styles.heroCaption}>Assigned in {monthLong}</Text>
          </View>

          {/* overspending warning + cover action */}
          {overspent ? (
            <View style={[styles.card, styles.warningCard]}>
              <Text style={styles.warningText}>
                You budgeted {formatMoney(assigned)}.{'\n'}But spent {formatMoney(spent)}!
              </Text>
              <Text style={[styles.warningText, { marginTop: 8 }]}>
                You have overspent this category by {formatMoney(-available.available)}.
              </Text>
              <Pressable
                style={styles.warningAction}
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  onMoveMoney({ from: null, to: category.id, pickFrom: true });
                }}>
                <Text style={styles.warningActionText}>Cover this overspending from…</Text>
              </Pressable>
            </View>
          ) : null}

          {/* balance breakdown */}
          <View style={styles.card}>
            {available.rows.map((row) => (
              <View key={row.key} style={styles.balRow}>
                <Text style={styles.balLabel}>
                  {row.key === 'carryover'
                    ? `Left Over from ${formatMonthLong(prevMonth(month))}`
                    : row.key === 'assigned'
                      ? `Assigned in ${monthLong}`
                      : row.key === 'activity'
                        ? 'Spending'
                        : row.key === 'funded'
                          ? 'Funded Card Spending'
                          : 'Payments Made'}
                </Text>
                <Text style={styles.balValue}>{formatMoney(row.cents)}</Text>
              </View>
            ))}
            <View style={[styles.balRow, styles.balTotal]}>
              <Text style={[styles.balLabel, styles.balTotalLabel]}>Available</Text>
              <Text style={[styles.balTotalValue, { color: availColors.fg }]}>{formatMoney(available.available)}</Text>
            </View>
            {available.kind === 'payment' ? (
              <>
                <View style={styles.balRow}>
                  <Text style={styles.balLabel}>Card Debt</Text>
                  <Text style={styles.balValue}>{formatMoney(available.debt ?? 0)}</Text>
                </View>
                {(available.underfunded ?? 0) > 0 ? (
                  <View style={styles.balRow}>
                    <Text style={[styles.balLabel, { color: colors.yellowPillFg }]}>Underfunded</Text>
                    <Text style={[styles.balValue, { color: colors.yellowPillFg }]}>{formatMoney(available.underfunded ?? 0)}</Text>
                  </View>
                ) : null}
              </>
            ) : null}
            {creditHint ? (
              <Text style={{ color: colors.yellowPillFg, fontSize: 12, lineHeight: 17, marginTop: 6 }}>{creditHint.detail}</Text>
            ) : null}
            {personName ? (
              // Filtered slice shown beside, never inside, the household breakdown.
              <View style={styles.balRow}>
                <Text style={styles.balLabel}>Activity · {personName}</Text>
                <Text style={styles.balValue}>{formatMoney(activityFor(bm, category.id, activityMap))}</Text>
              </View>
            ) : null}
            <Pressable
              style={styles.moveLink}
              accessibilityRole="button"
              onPress={() => {
                onClose();
                onMoveMoney({ from: category.id });
              }}>
              <Text style={styles.moveLinkText}>Move Money ›</Text>
            </Pressable>
          </View>

          {/* person */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Person</Text>
            <CategoryPersonField budgetId={budgetId} category={category} />
          </View>

          {/* auto-assign */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Auto-Assign</Text>
            <QuickAssignList
              budget={budget}
              budgetId={budgetId}
              month={month}
              category={category}
              snap={snap}
              onApplied={() => undefined}
            />
          </View>

          {/* target */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Target</Text>
            <InspectorTarget category={category} budgetId={budgetId} month={month} assigned={assigned} available={available.available} />
          </View>

          {/* actions */}
          <View style={styles.card}>
            <ActionRow label="＋ Transaction" onPress={addTransaction} />
            <ActionRow
              label="Rename Category"
              onPress={() => {
                setRenameDraft(category.name);
                setRenaming(true);
              }}
            />
            <ActionRow label="Hide Category" onPress={hide} />
            <ActionRow label="Delete Category" danger onPress={() => setConfirmDelete(true)} />
          </View>

          {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}

          <Text style={styles.footerNote}>
            Overspent categories show a red Available balance; cover them from another category or Ready to Assign.
          </Text>
        </ScrollView>

        {/* delete confirmation */}
        {confirmDelete ? (
          <Pressable style={styles.confirmBackdrop} onPress={() => setConfirmDelete(false)}>
            <View style={styles.confirmCard}>
              <Text style={styles.confirmText}>
                Delete “{category.name}”? Its transactions become uncategorized.
              </Text>
              <View style={styles.confirmBtns}>
                <Pressable onPress={() => setConfirmDelete(false)} style={styles.confirmBtn} accessibilityRole="button">
                  <Text style={styles.confirmBtnText}>Cancel</Text>
                </Pressable>
                <Pressable onPress={() => void doDelete()} style={styles.confirmBtn} accessibilityRole="button">
                  <Text style={[styles.confirmBtnText, { color: colors.redFg }]}>Delete</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  backBtn: { width: 44, alignItems: 'flex-start', paddingLeft: 10 },
  backText: { color: colors.text, fontSize: 28, lineHeight: 32, marginTop: -3 },
  title: { flex: 1, color: colors.text, fontSize: 18, fontWeight: '800' },
  renameInput: {
    flex: 1,
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    borderBottomWidth: 1,
    borderBottomColor: colors.indigo2,
    paddingVertical: 2,
  },
  scroll: { paddingHorizontal: 14, gap: 12, paddingTop: 6 },

  hero: { alignItems: 'center', paddingVertical: 22 },
  heroCaption: { color: colors.muted, fontSize: 13, marginTop: 6 },

  card: {
    backgroundColor: colors.card,
    borderRadius: radius.r,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  sectionTitle: { color: colors.faint, fontSize: 11, letterSpacing: 0.6, fontWeight: '700', marginBottom: 8 },

  warningCard: { backgroundColor: colors.redPillBg, borderColor: colors.redPillBg },
  warningText: { color: colors.redFg, fontSize: 14, fontWeight: '700', lineHeight: 20 },
  warningAction: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.redFg,
    paddingTop: 10,
  },
  warningActionText: { color: colors.redFg, fontSize: 14, fontWeight: '600' },

  balRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  balLabel: { color: colors.text, fontSize: 14 },
  balValue: { color: colors.text, fontSize: 14, fontVariant: ['tabular-nums'] },
  balTotal: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 2 },
  balTotalLabel: { fontWeight: '800' },
  balTotalValue: { fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  moveLink: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border },
  moveLinkText: { color: colors.indigo2, fontSize: 14, fontWeight: '600' },

  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  actionLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  actionChevron: { color: colors.muted, fontSize: 16 },

  errorText: { color: colors.redFg, fontSize: 12, textAlign: 'center' },
  footerNote: { color: colors.faint, fontSize: 12, lineHeight: 17, textAlign: 'center', paddingHorizontal: 20 },

  confirmBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmCard: {
    backgroundColor: colors.card2,
    borderRadius: radius.r,
    borderWidth: 1,
    borderColor: colors.border2,
    padding: 16,
    marginHorizontal: 40,
    maxWidth: 320,
  },
  confirmText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  confirmBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 18, marginTop: 14 },
  confirmBtn: { paddingVertical: 4 },
  confirmBtnText: { color: colors.text, fontSize: 14, fontWeight: '700' },
});
