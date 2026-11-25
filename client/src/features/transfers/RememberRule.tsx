/**
 * The popover's "Always treat <text> as a transfer" block: a checkbox and, when
 * it is ticked, the renaming rule it will create on the other account's
 * transfer payee: a match type and the text, pre-filled from the row's bank
 * text (see transferRule.logic) and editable before linking.
 */
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { RuleMatchType } from '@shared/domain/payees';
import { labels } from '@shared/i18n';

import { SelectionCheckbox } from '@/ui/SelectionCheckbox';
import { colors, radius } from '@/ui/theme';
import { t } from './i18n';
import { RULE_TYPES, type RuleDraft } from './transferRule.logic';

const TYPE_LABEL: Record<RuleMatchType, string> = labels(t, {
  is: 'rule.is',
  starts_with: 'rule.startsWith',
  ends_with: 'rule.endsWith',
  contains: 'rule.contains',
});

export function RememberRule({
  bankText,
  payeeLabel,
  on,
  onToggle,
  draft,
  onChange,
}: {
  /** The text the rule is built from (shown in the checkbox label). */
  bankText: string;
  /** The transfer payee the rule goes on ("Transfer : <account>"); null while the account is not chosen. */
  payeeLabel: string | null;
  on: boolean;
  onToggle: () => void;
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.check}>
        <SelectionCheckbox marginRight={0} checked={on} onToggle={onToggle} label={t('popover.remember', { payee: bankText })} />
        <Pressable style={{ flex: 1 }} onPress={onToggle}>
          <Text style={styles.text}>{t('popover.remember', { payee: bankText })}</Text>
          <Text style={styles.muted}>{payeeLabel ? t('popover.rememberSub', { payee: payeeLabel }) : t('popover.rememberSubAny')}</Text>
        </Pressable>
      </View>
      {on ? (
        <View style={styles.editor}>
          <View style={styles.types} accessibilityLabel={t('rule.matchLabel')}>
            {RULE_TYPES.map((mt) => (
              <Pressable
                key={mt}
                onPress={() => onChange({ ...draft, matchType: mt })}
                accessibilityRole="radio"
                accessibilityState={{ selected: draft.matchType === mt }}
                style={[styles.type, draft.matchType === mt && styles.typeOn]}>
                <Text style={[styles.typeText, draft.matchType === mt && styles.typeTextOn]}>{TYPE_LABEL[mt]}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            value={draft.text}
            onChangeText={(text) => onChange({ ...draft, text })}
            placeholderTextColor={colors.faint}
            style={styles.input}
            accessibilityLabel={t('rule.textLabel')}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginVertical: 8, gap: 8 },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: 4 },
  text: { color: colors.text, fontSize: 12 },
  muted: { color: colors.faint, fontSize: 11 },
  editor: { gap: 6, paddingLeft: 26 },
  types: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  type: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 10 },
  typeOn: { borderColor: colors.blue, backgroundColor: colors.bluePillBg },
  typeText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  typeTextOn: { color: colors.blue },
  input: {
    color: colors.text,
    fontSize: 12,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
});
