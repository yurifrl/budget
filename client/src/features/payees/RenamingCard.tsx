/**
 * The Renaming card of Manage Payees: every renaming rule of the selected
 * payee ([match type] [text] and a remove button each, a + for another), the
 * "Apply to past transactions" confirm under a rule, and the plain note that
 * a rule only works on what is imported from now on. The same card serves an
 * ordinary payee and an account's transfer payee.
 */

import { Pressable, Text, TextInput, View } from 'react-native';

import type { RuleMatchType } from '@shared/domain/payees';

import type { RenameRuleApplyResult } from '@/budget/data/api';
import type { PayeeAdminRow } from '@/budget/data/rows';
import { Combobox } from '@/ui/combobox';
import { SettingsCard, settingsCardText } from '@/ui/primitives/settingsCard';
import { displaySystemName } from '@/domain/systemNames';
import { colors } from '@/ui/theme';
import { ApplyPastConfirm } from './ApplyPastConfirm';
import { t } from './i18n';
import { NEW_KEY, RULE_MATCH_LABEL, RULE_MATCH_ORDER, ruleMatchFromLabel, transferPayeeLabel, type EditorRow } from './renameRules.logic';
import { styles } from './styles';
import { useRenameRules } from './useRenameRules';

function RuleRow({
  row,
  rules,
  countText,
}: {
  row: EditorRow;
  rules: ReturnType<typeof useRenameRules>;
  countText: (count: number) => string;
}) {
  const { edit, commit, pickMatchType, remove, openApply, closeApply, confirmApply, applyView } = rules;
  const isNew = row.ruleId === null;
  const view = applyView?.ruleId === row.key ? applyView : null;
  return (
    <View style={styles.ruleBlock}>
      <View style={styles.ruleForm}>
        <Combobox
          value={RULE_MATCH_LABEL[row.fields.matchType]}
          onChangeText={(v) => {
            // Pick-only: a typed label counts when it is exactly one of them.
            const mt = ruleMatchFromLabel(v);
            if (mt && mt !== row.fields.matchType) pickMatchType(row.key, mt);
          }}
          options={RULE_MATCH_ORDER.map((mt) => ({ key: mt, label: RULE_MATCH_LABEL[mt] }))}
          onPick={(key) => pickMatchType(row.key, key as RuleMatchType)}
          chevron
          pickOnly
          style={styles.ruleMatcher}
          containerStyle={styles.ruleMatcherBox}
          accessibilityLabel={t('rule.matcherLabel')}
        />
        <TextInput
          value={row.fields.condition}
          onChangeText={(v) => edit(row.key, { condition: v })}
          onEndEditing={() => void commit(row.key)}
          onSubmitEditing={() => void commit(row.key)}
          onBlur={() => void commit(row.key)}
          placeholder={t('rule.placeholder')}
          placeholderTextColor={colors.faint}
          editable={!row.saving}
          autoFocus={isNew}
          style={[styles.ruleInput, { flex: 1 }]}
          accessibilityLabel={t('rule.conditionLabel')}
        />
        <Pressable onPress={() => void remove(row.key)} accessibilityRole="button" accessibilityLabel={t('rule.remove')} hitSlop={8}>
          <Text style={styles.ruleRemove}>✕</Text>
        </Pressable>
      </View>
      {row.error ? (
        <Text style={settingsCardText.error} accessibilityRole="alert">
          {row.error}
        </Text>
      ) : null}
      {!isNew && !row.dirty && !view ? (
        <Pressable onPress={() => void openApply(row.key)} accessibilityRole="button" style={styles.ruleApply}>
          <Text style={styles.linkText}>{t('rule.applyLink')}</Text>
        </Pressable>
      ) : null}
      {view ? <ApplyPastConfirm view={view} countText={countText} onApply={() => void confirmApply()} onClose={closeApply} /> : null}
    </View>
  );
}

export function RenamingCard({
  budgetId,
  payee,
  onApplied,
}: {
  budgetId: string;
  payee: PayeeAdminRow;
  onApplied: (result: RenameRuleApplyResult) => void;
}) {
  const rules = useRenameRules({ budgetId, payee, onApplied });
  const isTransfer = payee.transfer_account_id !== null;
  const accountLabel = transferPayeeLabel(payee);
  const countText = (count: number) =>
    isTransfer
      ? t('apply.countTransfer', { count, account: payee.transfer_account_name ?? payee.name })
      : t('apply.countRename', { count, name: payee.name });
  const hasNewRow = rules.rows.some((r) => r.key === NEW_KEY);
  return (
    <SettingsCard>
      <Text style={settingsCardText.muted}>
        {isTransfer
          ? t('detail.renamingTransfer', { account: payee.transfer_account_name ?? accountLabel })
          : t('detail.renamingHint', { name: displaySystemName(payee.name) })}
      </Text>
      {rules.empty ? <Text style={settingsCardText.muted}>{t('rule.empty')}</Text> : null}
      {rules.rows.map((row) => (
        <RuleRow key={row.key} row={row} rules={rules} countText={countText} />
      ))}
      <Pressable
        onPress={rules.openNew}
        disabled={hasNewRow}
        accessibilityRole="button"
        accessibilityLabel={t('rule.add')}
        style={[styles.ruleAdd, hasNewRow && { opacity: 0.4 }]}>
        <Text style={styles.addRowBtn}>＋</Text>
      </Pressable>
      <Text style={settingsCardText.muted}>{t('rule.fromNowOn')}</Text>
    </SettingsCard>
  );
}
