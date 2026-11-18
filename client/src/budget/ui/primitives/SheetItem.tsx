import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '../theme';

/** A row inside an OverlaySheet (mock `.sheet-item`). */
export function SheetItem({
  icon,
  label,
  sub,
  active,
  onPress,
}: {
  icon?: string;
  label: string;
  sub?: string;
  active?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.sheetItem,
        active && { backgroundColor: colors.indigoSoft },
        pressed && { backgroundColor: colors.hover },
      ]}>
      {icon ? (
        <View style={styles.sheetItemIcon}>
          <Text style={{ fontSize: 14 }}>{icon}</Text>
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={styles.sheetItemLabel}>{label}</Text>
        {sub ? <Text style={styles.sheetItemSub}>{sub}</Text> : null}
      </View>
      {active ? <Text style={{ color: colors.indigo2 }}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    padding: 11,
    borderRadius: radius.sm,
  },
  sheetItemIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: colors.card2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetItemLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  sheetItemSub: { color: colors.faint, fontSize: 11 },
});
