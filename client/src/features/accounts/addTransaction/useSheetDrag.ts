import { useEffect, useRef } from 'react';
import { Animated, PanResponder } from 'react-native';

/**
 * Drag-down dismiss: the header is the grabber region; the sheet follows the
 * finger and commits the close past 120px, otherwise springs back.
 *
 * The responder is created once, so `onDismiss` is the first render's.
 */
export function useSheetDrag(visible: boolean, onDismiss: () => void) {
  const dragY = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) dragY.setValue(0);
  }, [visible, dragY]);
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && g.dy > Math.abs(g.dx) * 1.5,
      onPanResponderMove: (_e, g) => {
        if (g.dy > 0) dragY.setValue(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 120) {
          Animated.timing(dragY, { toValue: 900, duration: 220, useNativeDriver: true }).start(() => onDismiss());
        } else {
          Animated.spring(dragY, { toValue: 0, speed: 24, bounciness: 4, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;
  return { dragY, panHandlers: panResponder.panHandlers };
}
