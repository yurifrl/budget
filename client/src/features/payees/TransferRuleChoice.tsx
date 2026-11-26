/**
 * What is left of the old "treat as transfer" rule on an ordinary payee:
 * the notice that converts a rule which sent its rows to an account into
 * renaming rules on that account's transfer payee (the person picks the
 * account and sees, edits and removes the rules first), and the "Never a
 * transfer" choice, which stays.
 */

import { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { MIN_RULE_PATTERN_LENGTH, type RuleMatchType } from '@shared/domain/payees';

import type { PayeeAdminRow } from '@/budget/data/rows';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { Combobox } from '@/ui/combobox';
import { SettingsCard, SettingsCardButton, settingsCardText } from '@/ui/primitives/settingsCard';
import { SelectionCheckbox } from '@/ui/SelectionCheckbox';
import { colors } from '@/ui/theme';
import { t } from './i18n';
import {
  RULE_MATCH_LABEL,
  RULE_MATCH_ORDER,
  conversionPlan,
  defaultConversionTarget,
  ruleMatchFromLabel,
  transferPayeeLabel,
  visibleEntries,
  type ConversionEntry,
  type EntryEdits,
} from './renameRules.logic';
import { styles } from './styles';
import { useTransferRuleChoice } from './useTransferRuleChoice';

export function LegacyTransferNotice({
  budgetId,
  payee,
  targets,
  waiting,
}: {
  budgetId: string;
  payee: PayeeAdminRow;
  /** Transfer payees to choose from: open, on-budget accounts only. */
  targets: PayeeAdminRow[];
  /** The payee's transactions held as transfers still waiting for their other side: how many, and their total effect on Ready to Assign. */
  waiting: { count: number; cents: number };
}) {
  const money = useMoneyFormat();
  const { busy, error, convert } = useTransferRuleChoice({ budgetId, payee });
  // An "account" rule already names its account: it starts picked.
  const [pickedId, setPickedId] = useState<string | null>(() => defaultConversionTarget(payee, targets)?.id ?? null);
  const [text, setText] = useState(() => {
    const first = defaultConversionTarget(payee, targets);
    return first ? transferPayeeLabel(first) : '';
  });
  // The rules the conversion will create: shown, editable, removable. They follow the payee's CURRENT rules
  // (the Renaming card below can change them); only the person's own edits and removals made here are kept, by key.
  // Nothing happens until Convert.
  const [changes, setChanges] = useState<EntryEdits>({ edited: {}, removed: [] });
  const entries = useMemo(() => visibleEntries(payee, changes), [payee, changes]);
  const options = useMemo(() => targets.map((p) => ({ key: p.id, label: transferPayeeLabel(p) })), [targets]);
  const picked = targets.find((p) => p.id === pickedId) ?? null;
  const plan = useMemo(() => conversionPlan(entries), [entries]);
  const edit = (key: string, patch: Partial<Pick<ConversionEntry, 'matchType' | 'text'>>) =>
    setChanges((c) => ({ ...c, edited: { ...c.edited, [key]: { ...c.edited[key], ...patch } } }));
  const targetLabel = picked ? transferPayeeLabel(picked) : null;
  const problem = plan.tooShort.length > 0 ? t('legacy.tooShort', { min: MIN_RULE_PATTERN_LENGTH }) : plan.rules.length === 0 ? t('legacy.noRules') : null;
  return (
    <SettingsCard>
      <Text style={settingsCardText.body}>{t('legacy.notice')}</Text>
      <Text style={settingsCardText.body}>
        {t('legacy.effect', { payee: payee.name, account: targetLabel ? `“${targetLabel}”` : t('legacy.effectNoAccount') })}
      </Text>
      <Text style={styles.sectionLabel}>{t('legacy.rulesTitle')}</Text>
      <Text style={settingsCardText.muted}>{targetLabel ? t('legacy.rulesOn', { target: `“${targetLabel}”` }) : t('legacy.rulesOnNone')}</Text>
      {entries.map((e) => (
        <View key={e.key} style={styles.ruleForm}>
          <Combobox
            value={RULE_MATCH_LABEL[e.matchType]}
            onChangeText={(v) => {
              const mt = ruleMatchFromLabel(v);
              if (mt && mt !== e.matchType) edit(e.key, { matchType: mt });
            }}
            options={RULE_MATCH_ORDER.map((mt) => ({ key: mt, label: RULE_MATCH_LABEL[mt] }))}
            onPick={(key) => edit(e.key, { matchType: key as RuleMatchType })}
            chevron
            pickOnly
            style={styles.ruleMatcher}
            containerStyle={styles.ruleMatcherBox}
            accessibilityLabel={t('rule.matcherLabel')}
          />
          <TextInput
            value={e.text}
            onChangeText={(v) => edit(e.key, { text: v })}
            placeholder={t('rule.placeholder')}
            placeholderTextColor={colors.faint}
            style={[styles.ruleInput, { flex: 1 }]}
            accessibilityLabel={t('rule.conditionLabel')}
          />
          <Pressable
            onPress={() => setChanges((c) => ({ ...c, removed: [...c.removed, e.key] }))}
            accessibilityRole="button"
            accessibilityLabel={t('legacy.removeEntry')}
            hitSlop={8}>
            <Text style={styles.ruleRemove}>✕</Text>
          </Pressable>
        </View>
      ))}
      {entries.some((e) => e.moveFrom) ? <Text style={settingsCardText.muted}>{t('legacy.moved')}</Text> : null}
      {entries.some((e) => e.matchType === 'is') ? <Text style={settingsCardText.muted}>{t('legacy.isName')}</Text> : null}
      {waiting.count > 0 ? (
        <Text style={settingsCardText.muted}>
          {waiting.cents > 0
            ? t('legacy.waiting', { count: waiting.count, total: money.formatMoney(waiting.cents) })
            : waiting.cents < 0
              ? t('legacy.waitingUp', { count: waiting.count, total: money.formatMoney(-waiting.cents) })
              : t('legacy.waitingNoMoney', { count: waiting.count })}
        </Text>
      ) : null}
      {problem ? (
        <Text style={settingsCardText.error} accessibilityRole="alert">
          {problem}
        </Text>
      ) : null}
      <View style={styles.legacyRow}>
        <View style={styles.legacyPicker}>
          <Combobox
            value={text}
            onChangeText={(v) => {
              setText(v);
              if (picked && v !== transferPayeeLabel(picked)) setPickedId(null);
            }}
            options={options}
            onPick={(key) => {
              const p = targets.find((x) => x.id === key);
              setPickedId(key);
              setText(p ? transferPayeeLabel(p) : '');
            }}
            chevron
            pickOnly
            placeholder={t('legacy.pick')}
            style={styles.ruleMatcher}
            accessibilityLabel={t('legacy.accountLabel')}
          />
        </View>
        <SettingsCardButton
          label={t('legacy.convert')}
          primary
          busy={busy}
          disabled={!picked || problem !== null}
          onPress={() => picked && void convert(picked, plan.rules)}
        />
      </View>
      {error ? (
        <Text style={settingsCardText.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </SettingsCard>
  );
}

export function NeverTransferRow({ budgetId, payee }: { budgetId: string; payee: PayeeAdminRow }) {
  const { busy, error, setNever } = useTransferRuleChoice({ budgetId, payee });
  const on = payee.transfer_rule === 'never';
  return (
    <>
      <View style={styles.neverRow}>
        <SelectionCheckbox checked={on} onToggle={() => void setNever(!on)} label={t('never.label')} disabled={busy} marginRight={8} />
        <View style={styles.radioText}>
          <Text style={styles.radioTitle}>{t('never.label')}</Text>
          <Text style={styles.radioSub}>{t('never.sub')}</Text>
        </View>
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </>
  );
}
