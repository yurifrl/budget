/**
 * Web/Android trigger for the register row's context menu — a compact ⋯
 * button reporting its page position so the caller anchors the desktop-style
 * `TxnRowMenu` popup. iOS renders the whole row as the native context-menu
 * trigger instead (`TxnMenuTrigger.ios.tsx`), so `TxnMenuKebab.ios.tsx` is a
 * no-op stub there.
 */
import { Pressable, StyleSheet, Text } from "react-native";

import { colors } from "@/ui/theme";

export function TxnMenuKebab({
  onOpen,
}: {
  /** Page coordinates of the press, for popup anchoring. */
  onOpen: (pageX: number, pageY: number) => void;
}) {
  return (
    <Pressable
      hitSlop={6}
      style={styles.btn}
      onPress={(e) => {
        // Keep the row's own press (row editor) from firing behind the popup.
        e.stopPropagation();
        onOpen(e.nativeEvent.pageX, e.nativeEvent.pageY);
      }}
      accessibilityLabel="Transaction menu"
    >
      <Text style={styles.text}>⋯</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Same look as the old inline register button (syscd-app-42f).
  btn: { width: 24, alignItems: "center", justifyContent: "center" },
  text: { color: colors.faint, fontSize: 15, fontWeight: "700" },
});
