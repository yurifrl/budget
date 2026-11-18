import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text } from 'react-native';

import { colors, radius } from '@/ui/theme';

/**
 * Centered overlay sheet (mock `.overlay` + `.sheet`): a dim scrim with a card.
 * Tapping the scrim dismisses.
 */
export function OverlaySheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          {title ? <Text style={styles.sheetTitle}>{title}</Text> : null}
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  sheet: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.r,
    padding: 8,
    width: '100%',
    maxWidth: 420,
    maxHeight: '85%',
  },
  sheetTitle: {
    fontSize: 10,
    color: colors.faint,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    paddingHorizontal: 11,
    paddingTop: 9,
    paddingBottom: 5,
    fontWeight: '700',
  },
});
