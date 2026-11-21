/**
 * ConnectionRowButtons — the visible Sync + Edit icon buttons on a bank row
 * on every platform. Presentational; Edit opens the bank's settings page.
 */

import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '@/ui/theme';
import { t } from './i18n';

export function ConnectionRowButtons({
  institution,
  canSync,
  syncing,
  onSync,
  onEdit,
}: {
  institution: string;
  canSync: boolean;
  syncing: boolean;
  onSync: () => void;
  onEdit: () => void;
}) {
  return (
    <View style={styles.wrap}>
      <Pressable
        hitSlop={8}
        style={[styles.btn, !canSync && styles.dim]}
        disabled={!canSync}
        onPress={onSync}
        accessibilityRole="button"
        accessibilityLabel={t('row.syncA11y', { institution })}
        accessibilityState={{ disabled: !canSync, busy: syncing }}
      >
        {syncing ? (
          <ActivityIndicator size="small" color={colors.indigo2} />
        ) : (
          <Ionicons name="sync" size={20} color={colors.indigo2} />
        )}
      </Pressable>
      <Pressable
        hitSlop={8}
        style={styles.btn}
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel={t('row.editA11y', { institution })}
      >
        <Ionicons name="ellipsis-horizontal-circle" size={22} color={colors.indigo2} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', marginLeft: 0, flexShrink: 0 },
  btn: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  dim: { opacity: 0.35 },
});
