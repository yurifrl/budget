/** Unlink confirmation body: wrapped by a scrim in the modal, an OverlaySheet on the bank page. */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../../ui/theme';

export function UnlinkConfirm({
  accountName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  accountName: string;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Unlink bank account?</Text>
      <Text style={styles.body}>
        {`${accountName} will stop syncing with the bank. Transactions already imported stay in your budget; no new ones arrive until you link again.`}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.footer}>
        <Pressable style={styles.ghost} disabled={busy} onPress={onCancel} accessibilityRole="button">
          <Text style={styles.ghostText}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.danger} disabled={busy} onPress={onConfirm} accessibilityRole="button">
          <Text style={styles.dangerText}>{busy ? 'Unlinking…' : 'Unlink'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { padding: 6, gap: 8 },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  body: { color: colors.text, fontSize: 13, lineHeight: 18 },
  error: { color: colors.redFg, fontSize: 12 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 4 },
  ghost: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  ghostText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  danger: { backgroundColor: colors.redFg, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  dangerText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
