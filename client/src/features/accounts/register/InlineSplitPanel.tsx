/**
 * Split editor of the inline add / edit row (syscd-app-rlt): one line per
 * leg (category, memo, amount, remove), the running total and Done.
 */

import type { Dispatch, SetStateAction } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { emptySplit, removeSplitLeg, splitTotalLabel, updateSplitLeg } from '@/domain/inlineAdd';
import type { Budget, TransactionSplit } from '@/domain/types';
import type { BudgetMonth } from '@/domain/zeroSum';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { AmountCell } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';
import { CategoryDropdown } from '@/ui/dropdown/CategoryDropdown';

export function InlineSplitPanel({
  budget,
  bm,
  splits,
  onChange,
  onDone,
  onCreateCategory,
}: {
  budget: Budget;
  /** Figures for the month the category menus are scoped to. */
  bm: BudgetMonth;
  splits: TransactionSplit[];
  onChange: Dispatch<SetStateAction<TransactionSplit[]>>;
  /** Done: saves the row. */
  onDone: () => void;
  /** Create a category from a leg's menu, then assign it to that leg. */
  onCreateCategory: (query: string, assign: (id: string) => void) => void;
}) {
  const { formatMoney } = useMoneyFormat();
  const total = splitTotalLabel(splits, formatMoney);
  return (
    <View style={styles.splitPanel}>
      <View style={styles.splitHead}>
        <Text style={styles.splitHeadText}>Split across categories</Text>
        <Text style={[styles.splitTotal, total.zero && styles.splitTotalZero]}>{total.text}</Text>
        <Pressable onPress={() => onDone()} style={styles.splitDone} accessibilityLabel="Done splitting">
          <Text style={styles.splitDoneText}>Done</Text>
        </Pressable>
      </View>
      {splits.map((leg, i) => {
        const legCat = budget.categories.find((c) => c.id === leg.categoryId) ?? null;
        return (
          <View key={leg.id} style={styles.splitLeg}>
            <CategoryDropdown
              categories={budget.categories}
              groups={budget.groups}
              bundles={budget.bundles}
              currentCategoryId={leg.categoryId}
              bm={bm}
              accounts={budget.accounts}
              onPick={(picked) =>
                onChange((prev) => updateSplitLeg(prev, i, { categoryId: picked }))
              }
              onTransferPick={() => undefined}
              onCreate={(query) =>
                onCreateCategory(query, (id) =>
                  onChange((prev) => updateSplitLeg(prev, i, { categoryId: id })),
                )
              }
              placeholder={legCat?.name ?? 'Category'}
              containerStyle={{ flex: 1.4 }}
              accessibilityLabel={`Split ${i + 1} category`}
            />
            <TextInput
              value={leg.memo}
              onChangeText={(t) => onChange((prev) => updateSplitLeg(prev, i, { memo: t }))}
              placeholder="Memo"
              placeholderTextColor={colors.faint}
              style={[styles.input, { flex: 1.2 }]}
              accessibilityLabel={`Split ${i + 1} memo`}
            />
            <AmountCell
              outflowCents={leg.outflow}
              inflowCents={leg.inflow}
              onChange={({ outflowCents, inflowCents }) =>
                onChange((prev) => updateSplitLeg(prev, i, { outflow: outflowCents, inflow: inflowCents }))
              }
              style={{ flex: 1.1, minWidth: 0 }}
            />
            <Pressable
              onPress={() => onChange((prev) => removeSplitLeg(prev, i))}
              style={styles.splitRemove}
              accessibilityLabel={`Remove split ${i + 1}`}>
              <Text style={styles.splitRemoveText}>✕</Text>
            </Pressable>
          </View>
        );
      })}
      <Pressable onPress={() => onChange((prev) => [...prev, emptySplit()])} style={styles.splitAdd}>
        <Text style={styles.splitAddText}>+ Add another split</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    color: colors.text,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 13,
    minWidth: 0,
  },
  // Split editor (syscd-app-rlt).
  splitPanel: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    marginHorizontal: 20,
    marginBottom: 4,
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    gap: 6,
  },
  splitHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  splitHeadText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  splitTotal: { color: colors.text, fontSize: 12, fontWeight: '600', marginLeft: 'auto' },
  splitTotalZero: { color: colors.muted },
  splitDone: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 3,
    paddingHorizontal: 12,
    backgroundColor: colors.card,
  },
  splitDoneText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  splitLeg: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  splitRemove: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  splitRemoveText: { color: colors.redFg, fontSize: 13 },
  splitAdd: { alignSelf: 'flex-start', paddingVertical: 2 },
  splitAddText: { color: colors.indigo, fontSize: 12, fontWeight: '700' },
});
