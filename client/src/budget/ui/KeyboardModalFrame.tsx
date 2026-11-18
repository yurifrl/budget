/**
 * Centered form-modal frame that stays usable with the iOS software keyboard.
 * A transparent RN `Modal` is not resized by the keyboard, so the card would
 * sit behind it; `KeyboardAvoidingView` (padding, iOS only — Android resizes
 * the window, web has no on-screen keyboard) shrinks the available area, and the
 * card is bounded to it (`maxHeight`) so screens can scroll their form inside
 * (`<ScrollView keyboardShouldPersistTaps="handled">`). Tapping the dimmed area
 * calls `onBackdropPress`.
 */
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function KeyboardModalFrame({
  onBackdropPress,
  cardStyle,
  children,
}: {
  onBackdropPress: () => void;
  cardStyle: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  // Keep the card clear of the status bar when the keyboard leaves little room.
  const { top } = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView style={[styles.scrim, { paddingTop: top + 8 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onBackdropPress} accessibilityLabel="Dismiss" />
      <View style={[cardStyle, styles.card]}>{children}</View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.55)', alignItems: 'center', justifyContent: 'center' },
  card: { maxHeight: '92%' },
});
