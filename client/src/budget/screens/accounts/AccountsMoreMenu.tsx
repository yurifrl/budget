/**
 * All Accounts "more" menu — the phone ⋯ actions (File Import, Reconcile,
 * Show Reconciled, Edit Account, Link Account), lifted out of the toolbar
 * into the screen header so the trigger sits beside the title (spec item 9).
 * This is the web/Android fallback: the same Modal-backed dropdown the
 * toolbar used to own (tk-nual). iOS swaps in the native context menu —
 * `AccountsMoreMenu.ios.tsx`.
 */

import { useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewInstance,
} from 'react-native';

import { colors, radius } from '../../ui/theme';

export function AccountsMoreMenu({
  onImport,
  onReconcile,
  showReconciled,
  onToggleReconciled,
  onEditAccount,
}: {
  /** Open the file-import flow. */
  onImport: () => void;
  /** Start a reconcile session — omitted when no account is selected. */
  onReconcile?: () => void;
  /** Whether reconciled rows are currently shown (menu check mark). */
  showReconciled: boolean;
  onToggleReconciled: (show: boolean) => void;
  /** Edit the selected account — omitted on the All Accounts scope. */
  onEditAccount?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const moreBtnRef = useRef<ViewInstance>(null);

  // Measure the trigger and clamp x against the window so the right-aligned
  // menu stays on screen (same pattern as the toolbar menu this replaces,
  // tk-nual).
  const openMenu = () => {
    moreBtnRef.current?.measureInWindow((x, y, _w, h) => {
      setAnchor({ x: Math.max(8, x - 148), y: y + h + 6 });
      setMenuOpen(true);
    });
  };

  return (
    <>
      <View ref={moreBtnRef} collapsable={false}>
        <Pressable
          onPress={openMenu}
          style={styles.action}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="More actions"
          accessibilityHint="File Import, Reconcile, Show Reconciled, Edit Account, Link Account">
          <Text style={styles.moreDots}>⋯</Text>
        </Pressable>
      </View>
      <Modal transparent visible={menuOpen} animationType="none" onRequestClose={() => setMenuOpen(false)}>
        <Pressable
          style={styles.scrim}
          accessibilityLabel="Close actions menu"
          onPress={() => setMenuOpen(false)}
        />
        {anchor ? (
          <View style={[styles.menu, { top: anchor.y, left: anchor.x }]}>
            <Pressable
              onPress={() => {
                setMenuOpen(false);
                onImport();
              }}
              style={styles.menuItem}
              accessibilityRole="menuitem">
              <Text style={styles.menuItemText}>File Import</Text>
            </Pressable>
            {onReconcile ? (
              <Pressable
                onPress={() => {
                  setMenuOpen(false);
                  onReconcile();
                }}
                style={styles.menuItem}
                accessibilityRole="menuitem">
                <Text style={styles.menuItemText}>Reconcile</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => {
                onToggleReconciled(!showReconciled);
                setMenuOpen(false);
              }}
              style={styles.menuItem}
              accessibilityRole="menuitem">
              <Text style={styles.menuItemText}>Show Reconciled</Text>
              <Text style={styles.menuCheck}>{showReconciled ? '✓' : ''}</Text>
            </Pressable>
            {onEditAccount ? (
              <Pressable
                onPress={() => {
                  setMenuOpen(false);
                  onEditAccount();
                }}
                style={styles.menuItem}
                accessibilityRole="menuitem">
                <Text style={styles.menuItemText}>Edit Account</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  action: {
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  moreDots: { color: colors.indigo3, fontSize: 18, fontWeight: '700', lineHeight: 20 },
  scrim: { ...StyleSheet.absoluteFill },
  menu: {
    position: 'absolute',
    minWidth: 180,
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    paddingVertical: 4,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  menuItemText: { color: colors.text, fontSize: 13 },
  menuCheck: { color: colors.indigo2, fontSize: 13, fontWeight: '700', minWidth: 14, textAlign: 'right' },
});
