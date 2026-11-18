import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { Combobox } from '@/ui/combobox';
import { categorizationModes, matchTypeLabels, matchTypes, type CategorizationMode, type MatchType } from '@shared/domain/payees';

import { colors } from '@/ui/theme';
import { DefaultCategoryPicker } from './DefaultCategoryPicker';
import { MergePrompt } from './MergePrompt';
import { activityLine, matchTypeFromLabel } from './payees.logic';
import { PayeeTxnsPane } from './PayeeTxnsPane';
import { styles } from './styles';
import type { PayeeAdmin } from './usePayeeAdmin';

const CATEGORIZATION_LABELS: Record<CategorizationMode, { title: string; sub: string }> = {
  auto: { title: 'Auto-select', sub: 'suggest a category from past transactions' },
  fixed: { title: 'Fixed category', sub: 'always use the default category below' },
  never: { title: 'Never categorize', sub: 'leave new transactions uncategorized' },
};

/**
 * Right pane: the selected payee's details (rename, activity, categorization,
 * renaming rule, hide / merge / delete), or the merge prompt while it is open.
 */
export function PayeeDetailPane({ admin }: { admin: PayeeAdmin }) {
  const {
    budgetId,
    pickerBudget,
    activeMonth,
    addCategory,
    selected,
    mergeOpen,
    mergeCandidates,
    mergeTargetId,
    setMergeTargetId,
    doMerge,
    cancelMerge,
    nameDraft,
    editName,
    commitRename,
    nameError,
    showTxns,
    setShowTxns,
    setCategorizationMode,
    setDefaultCategory,
    setError,
    ruleDraft,
    setRuleDraft,
    draftMatchType,
    saveRule,
    toggleHidden,
    openMerge,
    tryDelete,
  } = admin;
  return (
    <ScrollView style={styles.detailPane} contentContainerStyle={styles.detailContent}>
      {!selected ? (
        <Text style={styles.empty}>Select a payee to edit its details.</Text>
      ) : mergeOpen ? (
        <MergePrompt
          payee={selected}
          candidates={mergeCandidates}
          targetId={mergeTargetId}
          onTargetChange={setMergeTargetId}
          onConfirm={() => void doMerge()}
          onCancel={cancelMerge}
        />
      ) : (
        <>
          <Text style={styles.sectionLabel}>NAME</Text>
          <View style={styles.nameRow}>
            <TextInput
              value={nameDraft ?? selected.name}
              onChangeText={editName}
              // RN-web never wires `onEndEditing` (types only), so
              // blur-commit needs the web-native onBlur too. The
              // nameDraftRef guard makes multi-fire commits idempotent.
              onEndEditing={commitRename}
              onSubmitEditing={commitRename}
              onBlur={commitRename}
              style={styles.nameInput}
            />
          </View>
          {nameError ? (
            <Text style={styles.error} accessibilityRole="alert">
              {nameError}
            </Text>
          ) : null}

          <Text style={styles.sectionLabel}>ACTIVITY</Text>
          <Text style={styles.activity}>{activityLine(selected)}</Text>

          {selected.transaction_count > 0 ? (
            <>
              <Pressable
                onPress={() => setShowTxns(!showTxns)}
                accessibilityRole="button"
                accessibilityState={{ expanded: showTxns }}>
                <Text style={styles.linkText}>
                  {showTxns ? 'Hide' : 'Show'} {selected.transaction_count} Transactions
                </Text>
              </Pressable>
              {showTxns ? (
                <PayeeTxnsPane budgetId={budgetId} payeeId={selected.id} />
              ) : null}
            </>
          ) : null}

          <Text style={styles.sectionLabel}>CATEGORIZATION</Text>
          {categorizationModes.map((mode) => (
            <Pressable
              key={mode}
              onPress={() => void setCategorizationMode(mode)}
              style={styles.radioRow}
              accessibilityRole="radio"
              accessibilityState={{ selected: selected.categorization_mode === mode }}>
              <Text style={[styles.radioDot, selected.categorization_mode === mode && styles.radioDotOn]}>
                {selected.categorization_mode === mode ? '●' : '○'}
              </Text>
              <View style={styles.radioText}>
                <Text style={styles.radioTitle}>{CATEGORIZATION_LABELS[mode].title}</Text>
                <Text style={styles.radioSub}>{CATEGORIZATION_LABELS[mode].sub}</Text>
              </View>
            </Pressable>
          ))}
          {selected.categorization_mode === 'auto' ? (
            <Text style={styles.radioSub}>
              {selected.inferred_category_name
                ? `Current default category: ${selected.inferred_category_name}`
                : 'Current default category: none yet'}
            </Text>
          ) : null}
          {selected.categorization_mode === 'fixed' && pickerBudget ? (
            <>
              <Text style={styles.pickerLabel}>Default category</Text>
              <DefaultCategoryPicker
                payee={selected}
                budget={pickerBudget}
                month={activeMonth}
                onCommit={(defaultCategoryId) => void setDefaultCategory(defaultCategoryId)}
                onCreateError={(err) => setError(apiErrorMessage(err, 'failed to create category'))}
                addCategory={addCategory}
                budgetId={budgetId}
              />
            </>
          ) : null}

          <Text style={styles.sectionLabel}>RENAMING</Text>
          <Text style={styles.radioSub}>
            Imported payees that match this rule will be renamed to “{selected.name}”.
          </Text>
          <View style={styles.ruleForm}>
            <Combobox
              value={matchTypeLabels[ruleDraft?.matchType ?? selected.rename_match_type ?? 'contains']}
              onChangeText={(v) => {
                // Matcher is pick-only: adopt a typed label when it
                // matches exactly, otherwise snap back to the current one.
                const mt = matchTypeFromLabel(v);
                if (mt && mt !== draftMatchType) void saveRule({ matchType: mt });
              }}
              options={matchTypes.map((mt) => ({ key: mt, label: matchTypeLabels[mt] }))}
              onPick={(key) => void saveRule({ matchType: key as MatchType })}
              chevron
              style={styles.ruleMatcher}
              containerStyle={styles.ruleMatcherBox}
              accessibilityLabel="Renaming matcher"
            />
            <TextInput
              value={ruleDraft?.condition ?? selected.rename_condition ?? ''}
              onChangeText={(v) => setRuleDraft({ matchType: draftMatchType, condition: v })}
              onEndEditing={() => void saveRule()}
              onSubmitEditing={() => void saveRule()}
              onBlur={() => void saveRule()}
              placeholder={draftMatchType === 'is' ? 'Is…' : 'Contains…'}
              placeholderTextColor={colors.faint}
              style={[styles.ruleInput, { flex: 1 }]}
              accessibilityLabel="Renaming condition"
            />
          </View>

          <View style={styles.footerRow}>
            <Pressable onPress={() => void toggleHidden()} accessibilityRole="button">
              <Text style={styles.linkText}>{selected.hidden ? 'Unhide this payee' : 'Hide this payee'}</Text>
            </Pressable>
            {selected.transaction_count > 0 && mergeCandidates.length > 0 ? (
              <Pressable onPress={openMerge} accessibilityRole="button">
                <Text style={styles.linkText}>Merge into…</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={tryDelete} accessibilityRole="button">
              <Text style={styles.deleteText}>Delete</Text>
            </Pressable>
          </View>
        </>
      )}
    </ScrollView>
  );
}
