/**
 * The transaction page (`/transaction?id=<transaction id>`, budget-hebq):
 * everything known about one transaction of the open budget. Header with
 * payee, amount and date; "Details" (the register fields, formatted);
 * "Split" for split rows; "Import" (bank, provider, the bank's transaction
 * id, sync state) or the hand-entered note; "Bank data" (every field of the
 * provider's raw transaction object) and the last synced fields, each with
 * Copy JSON. Opened from the register row menu's Details item; deep-linkable.
 */
import { skipToken } from '@reduxjs/toolkit/query';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import { tCommon } from '@shared/i18n/common';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useGetTransactionDetailsQuery, type TransactionDetails } from '@/budget/data/api';
import { displayFlagLabel } from '@/domain/flagLabels';
import { displaySystemName } from '@/domain/systemNames';
import type { FlagColor } from '@/domain/types';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useBudgetShell } from '@/shell/context';
import { useAppSelector } from '@/state/hooks';
import { selectActiveBudgetId } from '@/state/ui';
import { useFlagLabels } from '@/state/useDisplayPrefs';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';

import { FieldList, ImportSection, Section, SplitsSection } from './DetailSections';
import { t } from './i18n';
import { JsonSection } from './RawDataTree';
import { styles } from './styles';
import { detailFields, formatMilli } from './transactionDetail.logic';

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}

export function TransactionDetailScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const budgetId = useAppSelector(selectActiveBudgetId);
  const shell = useBudgetShell();
  const router = useRouter();
  const query = useGetTransactionDetailsQuery(id && budgetId ? { budgetId, id } : skipToken);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/accounts'));
  const frame = (body: React.ReactNode) => (
    <View style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>{body}</View>
  );
  const centered = (body: React.ReactNode) => frame(<View style={styles.centered}>{body}</View>);

  if (!id) return centered(<Text style={styles.hint}>{t('screen.noId')}</Text>);
  if (query.isLoading || (!query.data && !query.error)) {
    return centered(<ActivityIndicator color={colors.indigo2} accessibilityLabel={tCommon('loading')} />);
  }
  if (query.error || !query.data) {
    const message = isNotFound(query.error) ? t('screen.notFound') : apiErrorMessage(query.error, t('screen.loadFailed'));
    return centered(<Text style={styles.hint}>{message}</Text>);
  }

  return frame(
    <ScrollView contentContainerStyle={[styles.scroll, shell.isPhone && styles.scrollPhone]}>
      <DetailBody data={query.data} phone={shell.isPhone} onBack={back} />
    </ScrollView>,
  );
}

function DetailBody({ data, phone, onBack }: { data: TransactionDetails; phone: boolean; onBack: () => void }) {
  const fmt = useMoneyFormat();
  const flagLabels = useFlagLabels();
  const txn = data.transaction;
  const payee = displaySystemName(txn.payee_name ?? '') || t('screen.noPayee');
  const flag = txn.flag_color ? displayFlagLabel(flagLabels, txn.flag_color as FlagColor) : null;
  const imp = data.import;

  return (
    <>
      <View style={styles.head}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel={tCommon('back')}>
          <Ionicons name="chevron-back" size={20} color={colors.muted} />
        </Pressable>
        <View style={styles.headMain}>
          <Text style={styles.eyebrow}>{t('screen.title')}</Text>
          <Text style={styles.title} numberOfLines={2} selectable>
            {payee}
          </Text>
          <Text style={styles.subtitle}>{[fmt.formatDateLong(txn.date), txn.account_name].join(' · ')}</Text>
          {txn.deleted ? <Text style={styles.badge}>{t('screen.deleted')}</Text> : null}
        </View>
        <Text style={[styles.amount, txn.amount < 0 ? styles.amountOut : styles.amountIn]}>
          {formatMilli(fmt, txn.amount)}
        </Text>
      </View>

      <Section title={t('section.details')}>
        <FieldList phone={phone} rows={detailFields(txn, fmt, { payee, flag })} />
      </Section>
      {txn.subtransactions.length > 0 ? <SplitsSection subs={txn.subtransactions} /> : null}
      <ImportSection imp={imp} phone={phone} />
      {imp ? (
        imp.raw ? (
          <JsonSection title={t('section.bankData')} value={imp.raw} />
        ) : (
          <Section title={t('section.bankData')}>
            <Text style={[styles.hint, { textAlign: 'left', paddingVertical: 6 }]}>{t('raw.notYet')}</Text>
          </Section>
        )
      ) : null}
      {imp ? <JsonSection title={t('section.lastSynced')} value={imp.last_synced_payload} /> : null}
    </>
  );
}
