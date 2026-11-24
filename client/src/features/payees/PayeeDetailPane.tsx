import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { Combobox } from '@/ui/combobox';
import { categorizationModes, matchTypes, type CategorizationMode, type MatchType } from '@shared/domain/payees';
import { labels } from '@shared/i18n';
import { tCommon } from '@shared/i18n/common';

import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';
import { DefaultCategoryPicker } from './DefaultCategoryPicker';
import { MergePrompt } from './MergePrompt';
import { t } from './i18n';
import { activityLine, MATCH_TYPE_LABEL, matchTypeFromLabel } from './payees.logic';
import { PayeeTxnsPane } from './PayeeTxnsPane';
import { styles } from './styles';
import type { PayeeAdmin } from './usePayeeAdmin';
import { displaySystemName } from '@/domain/systemNames';
import { TransferRuleSection } from '@/features/transfers';

const CATEGORIZATION_LABELS: Record<CategorizationMode, { title: string; sub: string }> = {
  auto: labels(t, { title: 'mode.auto.title', sub: 'mode.auto.sub' }),
  fixed: labels(t, { title: 'mode.fixed.title', sub: 'mode.fixed.sub' }),
  never: labels(t, { title: 'mode.never.title', sub: 'mode.never.sub' }),
};

/**
 * Right pane: the selected payee's details (rename, activity, categorization,
 * renaming rule, hide / merge / delete), or the merge prompt while it is open.
 */
export function PayeeDetailPane({ admin }: { admin: PayeeAdmin }) {
  const money = useMoneyFormat();
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
        <Text style={styles.empty}>{t('detail.empty')}</Text>
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
          <Text style={styles.sectionLabel}>{t('detail.name')}</Text>
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

          <Text style={styles.sectionLabel}>{t('detail.activity')}</Text>
          <Text style={styles.activity}>{activityLine(selected, money)}</Text>

          {selected.transaction_count > 0 ? (
            <>
              <Pressable
                onPress={() => setShowTxns(!showTxns)}
                accessibilityRole="button"
                accessibilityState={{ expanded: showTxns }}>
                <Text style={styles.linkText}>
                  {showTxns
                    ? t('detail.hideTxns', { count: selected.transaction_count })
                    : t('detail.showTxns', { count: selected.transaction_count })}
                </Text>
              </Pressable>
              {showTxns ? (
                <PayeeTxnsPane budgetId={budgetId} payeeId={selected.id} />
              ) : null}
            </>
          ) : null}

          <Text style={styles.sectionLabel}>{t('detail.categorization')}</Text>
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
                ? t('detail.defaultCategoryCurrent', { name: selected.inferred_category_name })
                : t('detail.defaultCategoryNone')}
            </Text>
          ) : null}
          {selected.categorization_mode === 'fixed' && pickerBudget ? (
            <>
              <Text style={styles.pickerLabel}>{t('detail.defaultCategory')}</Text>
              <DefaultCategoryPicker
                payee={selected}
                budget={pickerBudget}
                month={activeMonth}
                onCommit={(defaultCategoryId) => void setDefaultCategory(defaultCategoryId)}
                onCreateError={(err) => setError(apiErrorMessage(err, t('error.createCategory')))}
                addCategory={addCategory}
                budgetId={budgetId}
              />
            </>
          ) : null}

          <TransferRuleSection budgetId={budgetId} payee={selected} accounts={pickerBudget?.accounts ?? []} />

          <Text style={styles.sectionLabel}>{t('detail.renaming')}</Text>
          <Text style={styles.radioSub}>
            {t('detail.renamingHint', { name: displaySystemName(selected.name) })}
          </Text>
          <View style={styles.ruleForm}>
            <Combobox
              value={MATCH_TYPE_LABEL[ruleDraft?.matchType ?? selected.rename_match_type ?? 'contains']}
              onChangeText={(v) => {
                // Matcher is pick-only: adopt a typed label when it
                // matches exactly, otherwise snap back to the current one.
                const mt = matchTypeFromLabel(v);
                if (mt && mt !== draftMatchType) void saveRule({ matchType: mt });
              }}
              options={matchTypes.map((mt) => ({ key: mt, label: MATCH_TYPE_LABEL[mt] }))}
              onPick={(key) => void saveRule({ matchType: key as MatchType })}
              chevron
              style={styles.ruleMatcher}
              containerStyle={styles.ruleMatcherBox}
              accessibilityLabel={t('rule.matcherLabel')}
            />
            <TextInput
              value={ruleDraft?.condition ?? selected.rename_condition ?? ''}
              onChangeText={(v) => setRuleDraft({ matchType: draftMatchType, condition: v })}
              onEndEditing={() => void saveRule()}
              onSubmitEditing={() => void saveRule()}
              onBlur={() => void saveRule()}
              placeholder={draftMatchType === 'is' ? t('rule.isPlaceholder') : t('rule.containsPlaceholder')}
              placeholderTextColor={colors.faint}
              style={[styles.ruleInput, { flex: 1 }]}
              accessibilityLabel={t('rule.conditionLabel')}
            />
          </View>

          <View style={styles.footerRow}>
            <Pressable onPress={() => void toggleHidden()} accessibilityRole="button">
              <Text style={styles.linkText}>{selected.hidden ? t('detail.unhide') : t('detail.hide')}</Text>
            </Pressable>
            {selected.transaction_count > 0 && mergeCandidates.length > 0 ? (
              <Pressable onPress={openMerge} accessibilityRole="button">
                <Text style={styles.linkText}>{t('detail.mergeInto')}</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={tryDelete} accessibilityRole="button">
              <Text style={styles.deleteText}>{tCommon('delete')}</Text>
            </Pressable>
          </View>
        </>
      )}
    </ScrollView>
  );
}
