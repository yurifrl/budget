import { Pressable, Text, View } from 'react-native';

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
          <Text style={styles.confirmTitle}>Delete Account</Text>
          <Text style={styles.confirmBody}>
            Permanently delete <Text style={styles.confirmBodyStrong}>{accountName}</Text> and
            every transaction it ever held? The account&apos;s balance will be removed from
            your plan. This cannot be undone.
          </Text>
          <View style={styles.confirmFooter}>
            <Pressable style={styles.ghostBtn} disabled={deleting} onPress={onCancel}>
              <Text style={styles.ghostText}>Cancel</Text>
            </Pressable>
            <Pressable style={styles.deleteBtn} disabled={deleting} onPress={onConfirm}>
              <Text style={styles.deleteText}>{deleting ? 'Deleting…' : 'Delete'}</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
  );
}
