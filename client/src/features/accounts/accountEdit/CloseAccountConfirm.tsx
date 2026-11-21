import { Pressable, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { closeConfirm } from '@/domain/accountEdit';
import { rich } from '@/ui/i18n/rich';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { t } from './i18n';
import { styles } from './styles';

/**
 * YNAB's Close Account confirm over the modal card: the plain "are you sure"
 * for a zero balance, otherwise the adjustment that zeroes `amount` out.
 */
export function CloseAccountConfirm({
  amount,
  onBudget,
  busy,
  onCancel,
  onConfirm,
}: {
  /** The working balance being zeroed out (cents). */
  amount: number;
  onBudget: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { formatMoney } = useMoneyFormat();
  const confirm = closeConfirm(amount, onBudget);
  return (
      <Pressable style={styles.confirmScrim} onPress={(e) => e.stopPropagation()}>
        <View style={styles.confirmBox}>
          <Text style={styles.confirmTitle}>{t('close.title')}</Text>
          {confirm.kind === 'plain' ? (
            <>
              <Text style={styles.confirmBody}>{t('close.plain')}</Text>
              <View style={styles.confirmFooter}>
                <Pressable style={styles.ghostBtn} onPress={onCancel}>
                  <Text style={styles.ghostText}>{tCommon('cancel')}</Text>
                </Pressable>
                <Pressable style={styles.closeAccountBtn} disabled={busy} onPress={onConfirm}>
                  <Text style={styles.closeAccountText}>{t('close.confirm')}</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.confirmBody}>
                {rich(t('close.adjustBody', { amount: formatMoney(confirm.adjustment) }), {
                  b: (children) => <Text style={styles.confirmBodyStrong}>{children}</Text>,
                })}
              </Text>
              {confirm.leavesPlan ? (
                <Text style={styles.helpbox}>
                  {t('close.leavesPlan')}
                </Text>
              ) : null}
              <View style={styles.confirmFooter}>
                <Pressable style={styles.ghostBtn} onPress={onCancel}>
                  <Text style={styles.ghostText}>{tCommon('cancel')}</Text>
                </Pressable>
                <Pressable style={styles.indigoBtn} disabled={busy} onPress={onConfirm}>
                  <Text style={styles.indigoText}>{t('close.adjustConfirm')}</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </Pressable>
  );
}
