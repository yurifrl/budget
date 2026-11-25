/**
 * Right pane for an account's transfer payee: its name (read only: it follows
 * the account), activity, the Renaming card with all its rules, and the note
 * that the app owns these payees. No rename, merge, hide, delete or
 * categorization controls.
 */

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { RenameRuleApplyResult } from '@/budget/data/api';
import type { PayeeAdminRow } from '@/budget/data/rows';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { t } from './i18n';
import { activityLine } from './payees.logic';
import { PayeeTxnsPane } from './PayeeTxnsPane';
import { RenamingCard } from './RenamingCard';
import { transferPayeeLabel } from './renameRules.logic';
import { styles } from './styles';

export function TransferPayeeDetail({
  budgetId,
  payee,
  accountClosed,
  onApplied,
}: {
  budgetId: string;
  payee: PayeeAdminRow;
  accountClosed: boolean;
  onApplied: (result: RenameRuleApplyResult) => void;
}) {
  const money = useMoneyFormat();
  const [showTxns, setShowTxns] = useState(false);
  return (
    <>
      <Text style={styles.sectionLabel}>{t('detail.name')}</Text>
      <View style={styles.nameRow}>
        <Text style={[styles.nameInput, styles.nameReadOnly]} selectable accessibilityRole="text">
          {transferPayeeLabel(payee)}
        </Text>
      </View>
      {accountClosed ? <Text style={styles.radioSub}>{t('detail.accountClosed')}</Text> : null}

      <Text style={styles.sectionLabel}>{t('detail.activity')}</Text>
      <Text style={styles.activity}>{activityLine(payee, money)}</Text>
      {payee.transaction_count > 0 ? (
        <>
          <Pressable onPress={() => setShowTxns(!showTxns)} accessibilityRole="button" accessibilityState={{ expanded: showTxns }}>
            <Text style={styles.linkText}>
              {showTxns
                ? t('detail.hideTxns', { count: payee.transaction_count })
                : t('detail.showTxns', { count: payee.transaction_count })}
            </Text>
          </Pressable>
          {showTxns ? <PayeeTxnsPane budgetId={budgetId} payeeId={payee.id} /> : null}
        </>
      ) : null}

      <Text style={styles.sectionLabel}>{t('detail.renaming')}</Text>
      <RenamingCard key={payee.id} budgetId={budgetId} payee={payee} onApplied={onApplied} />

      <Text style={[styles.radioSub, styles.transferNote]}>{t('detail.transferNote')}</Text>
    </>
  );
}
