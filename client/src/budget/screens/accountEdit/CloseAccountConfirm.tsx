import { Pressable, Text, View } from 'react-native';

import { closeConfirm } from '../../domain/accountEdit';
import { useMoneyFormat } from '../../model/useDisplayPrefs';
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
          <Text style={styles.confirmTitle}>Close Account</Text>
          {confirm.kind === 'plain' ? (
            <>
              <Text style={styles.confirmBody}>
                Are you sure you want to close this account?
              </Text>
              <View style={styles.confirmFooter}>
                <Pressable style={styles.ghostBtn} onPress={onCancel}>
                  <Text style={styles.ghostText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.closeAccountBtn} disabled={busy} onPress={onConfirm}>
                  <Text style={styles.closeAccountText}>Close</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.confirmBody}>
                Before you can close this account, the balance will have to be zeroed
                out. An adjustment transaction will be created for{' '}
                <Text style={styles.confirmBodyStrong}>
                  {formatMoney(confirm.adjustment)}
                </Text>
                .
              </Text>
              {confirm.leavesPlan ? (
                <Text style={styles.helpbox}>
                  The money in this account will be removed from your plan. If you
                  would like to keep it in your plan, you can transfer it to another
                  account before closing this one.
                </Text>
              ) : null}
              <View style={styles.confirmFooter}>
                <Pressable style={styles.ghostBtn} onPress={onCancel}>
                  <Text style={styles.ghostText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.indigoBtn} disabled={busy} onPress={onConfirm}>
                  <Text style={styles.indigoText}>Adjust Balance &amp; Close</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </Pressable>
  );
}
