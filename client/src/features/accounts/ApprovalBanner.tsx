/**
 * YNAB-style approval banner — indigo strip above the All Accounts title:
 * "N new transactions to approve or categorize." with a View action that
 * filters the register to the unapproved rows, plus a ✕ dismiss. The parent
 * renders it only while there are unapproved transactions in scope.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/ui/theme';

export function ApprovalBanner({
  count,
  active,
  onView,
  onDismiss,
}: {
  count: number;
  /** True while the register is filtered to the banner's rows. */
  active: boolean;
  onView: () => void;
  onDismiss: () => void;
}) {
  return (
    <View style={styles.banner}>
      <Text style={styles.icon} accessibilityLabel="Information">
        ⓘ
      </Text>
      <Text style={styles.text} numberOfLines={2}>
        {count} new transaction{count === 1 ? '' : 's'} to approve or categorize.
      </Text>
      <Pressable
        onPress={onView}
        style={styles.viewBtn}
        accessibilityRole="button"
        accessibilityLabel={active ? 'Show all transactions' : 'View unapproved transactions'}>
        <Text style={styles.viewText}>{active ? 'View all' : 'View'}</Text>
      </Pressable>
      <Pressable
        onPress={onDismiss}
        style={styles.dismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss approval banner">
        <Text style={styles.dismissText}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 20,
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: colors.indigoSoft,
    borderWidth: 1,
    borderColor: colors.indigo,
    borderRadius: radius.sm,
  },
  icon: { color: colors.indigo2, fontSize: 15 },
  text: { color: colors.text, fontSize: 13, flex: 1 },
  viewBtn: {
    backgroundColor: colors.indigo,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: 14,
  },
  viewText: { color: colors.white, fontWeight: '700', fontSize: 12 },
  dismiss: { paddingHorizontal: 6, paddingVertical: 2 },
  dismissText: { color: colors.muted, fontSize: 14 },
});