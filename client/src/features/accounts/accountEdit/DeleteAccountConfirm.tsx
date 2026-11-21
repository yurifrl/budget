import { Pressable, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { rich } from '@/ui/i18n/rich';
import { t } from './i18n';
import { styles } from './styles';

/** Destructive delete confirm (closed accounts only) over the modal card. */
export function DeleteAccountConfirm({
  accountName,
  deleting,
  onCancel,
  onConfirm,
}: {
  accountName: string;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
      <Pressable style={styles.confirmScrim} onPress={(e) => e.stopPropagation()}>
        <View style={styles.confirmBox}>
          <Text style={styles.confirmTitle}>{t('delete.title')}</Text>
          <Text style={styles.confirmBody}>
            {rich(t('delete.body', { accountName }), {
              b: (children) => <Text style={styles.confirmBodyStrong}>{children}</Text>,
            })}
          </Text>
          <View style={styles.confirmFooter}>
            <Pressable style={styles.ghostBtn} disabled={deleting} onPress={onCancel}>
              <Text style={styles.ghostText}>{tCommon('cancel')}</Text>
            </Pressable>
            <Pressable style={styles.deleteBtn} disabled={deleting} onPress={onConfirm}>
              <Text style={styles.deleteText}>{deleting ? t('delete.deleting') : tCommon('delete')}</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
  );
}
