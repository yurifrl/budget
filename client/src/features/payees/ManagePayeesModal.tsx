/**
 * Manage Payees modal — YNAB parity (issue syscd-app-0px). RN Modal sheet
 * hosting the shared ManagePayeesBody (same two-pane layout the routed page
 * uses). Entry points outside the settings pane — register payee dropdown,
 * Budget Home, Import — mount this; the settings entry routes to
 * /payees instead. Scrim click, ✕ header button and Esc
 * (onRequestClose) all close it.
 */

import { Modal, Pressable, StyleSheet } from 'react-native';

import { ManagePayeesBody } from './ManagePayeesScreen';
import { colors, radius } from '@/ui/theme';

export function ManagePayeesModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={styles.modal} onPress={(e) => e.stopPropagation()}>
          <ManagePayeesBody onClose={onClose} />
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
  },
  modal: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.r,
    padding: 14,
    width: '92%',
    maxWidth: 780,
    maxHeight: '85%',
  },
});
