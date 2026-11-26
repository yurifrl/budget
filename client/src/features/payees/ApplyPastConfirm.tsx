/**
 * The small confirm under a renaming rule: what "Apply to past transactions"
 * would change (count, the newest few rows), what it leaves alone and why,
 * then Apply. The preview is a dry run; nothing is written until Apply.
 */

import { ActivityIndicator, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { milliToCents } from '@/budget/data/mapping';
import { SettingsCardButton, settingsCardText } from '@/ui/primitives/settingsCard';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';
import { t } from './i18n';
import { skippedLines } from './renameRules.logic';
import { styles } from './styles';
import type { ApplyView } from './useRenameRules';

export function ApplyPastConfirm({
  view,
  /** The sentence for "N rows will ..." (it names the payee or the account). */
  countText,
  onApply,
  onClose,
}: {
  view: ApplyView;
  countText: (count: number) => string;
  onApply: () => void;
  onClose: () => void;
}) {
  const money = useMoneyFormat();
  if (view.phase === 'loading') {
    return (
      <View style={styles.applyBox} accessibilityLiveRegion="polite">
        <View style={styles.applyLoading}>
          <ActivityIndicator color={colors.indigo2} />
          <Text style={settingsCardText.muted}>{t('apply.loading')}</Text>
        </View>
      </View>
    );
  }
  if (view.phase === 'error') {
    return (
      <View style={styles.applyBox}>
        <Text style={settingsCardText.error} accessibilityRole="alert">
          {view.message}
        </Text>
        <SettingsCardButton label={tCommon('close')} onPress={onClose} />
      </View>
    );
  }
  const { preview } = view;
  const left = skippedLines(preview.skipped);
  return (
    <View style={styles.applyBox}>
      <Text style={settingsCardText.body}>{preview.count > 0 ? countText(preview.count) : t('apply.none')}</Text>
      {preview.sample.length > 0 ? (
        <View style={styles.applySample}>
          <Text style={styles.applyHead}>{t('apply.sampleTitle')}</Text>
          {preview.sample.map((row) => (
            <View key={row.id} style={styles.applyRow}>
              <View style={styles.applyRowText}>
                <Text style={styles.applyBank} numberOfLines={1}>
                  {row.bank_text}
                </Text>
                <Text style={styles.applySub} numberOfLines={1}>
                  {money.formatDate(row.date.slice(0, 10))}
                  {row.payee_name ? ` · ${t('apply.samplePayee', { name: row.payee_name })}` : ''}
                </Text>
              </View>
              <Text style={[styles.applyAmount, row.amount < 0 && styles.txnsAmountNeg]}>
                {money.formatMoney(milliToCents(row.amount))}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {left.length > 0 ? (
        <View>
          <Text style={styles.applyHead}>{t('apply.skippedTitle')}</Text>
          {left.map((line) => (
            <Text key={line} style={settingsCardText.muted}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {view.error ? (
        <Text style={settingsCardText.error} accessibilityRole="alert">
          {view.error}
        </Text>
      ) : null}
      <View style={styles.applyActions}>
        <SettingsCardButton label={tCommon('cancel')} onPress={onClose} grow />
        {preview.count > 0 ? (
          <SettingsCardButton label={t('apply.confirm', { count: preview.count })} primary busy={view.applying} onPress={onApply} grow />
        ) : null}
      </View>
    </View>
  );
}
