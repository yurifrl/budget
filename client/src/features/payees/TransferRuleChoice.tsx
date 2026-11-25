/**
 * What is left of the old "treat as transfer" rule on an ordinary payee:
 * the notice that converts a rule which sent its rows to an account into a
 * renaming rule on that account's transfer payee (the person picks the
 * account once), and the "Never a transfer" choice, which stays.
 */

import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import type { PayeeAdminRow } from '@/budget/data/rows';
import { Combobox } from '@/ui/combobox';
import { SettingsCard, SettingsCardButton, settingsCardText } from '@/ui/primitives/settingsCard';
import { SelectionCheckbox } from '@/ui/SelectionCheckbox';
import { t } from './i18n';
import { defaultConversionTarget, transferPayeeLabel } from './renameRules.logic';
import { styles } from './styles';
import { useTransferRuleChoice } from './useTransferRuleChoice';

export function LegacyTransferNotice({
  budgetId,
  payee,
  targets,
  closedIds,
}: {
  budgetId: string;
  payee: PayeeAdminRow;
  /** Transfer payees to choose from (open accounts first). */
  targets: PayeeAdminRow[];
  closedIds: ReadonlySet<string>;
}) {
  const { busy, error, convert } = useTransferRuleChoice({ budgetId, payee });
  // An "account" rule already names its account: it starts picked.
  const [pickedId, setPickedId] = useState<string | null>(() => defaultConversionTarget(payee, targets)?.id ?? null);
  const [text, setText] = useState(() => {
    const first = defaultConversionTarget(payee, targets);
    return first ? transferPayeeLabel(first) : '';
  });
  const options = useMemo(
    () =>
      targets.map((p) => ({
        key: p.id,
        label: transferPayeeLabel(p),
        sub: p.transfer_account_id && closedIds.has(p.transfer_account_id) ? t('list.closed') : undefined,
      })),
    [targets, closedIds],
  );
  const picked = targets.find((p) => p.id === pickedId) ?? null;
  return (
    <SettingsCard>
      <Text style={settingsCardText.body}>{t('legacy.notice')}</Text>
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
        <SettingsCardButton label={t('legacy.convert')} primary busy={busy} disabled={!picked} onPress={() => picked && void convert(picked)} />
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
