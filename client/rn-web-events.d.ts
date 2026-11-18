/**
 * RN 0.88's regenerated ViewProps dropped `onContextMenu`, but
 * react-native-web still implements it on View and Pressable (it forwards
 * contextmenu to the DOM). Desktop-web right-click menus in this app depend
 * on it, so re-declare the handler; PressableProps extends ViewProps, so
 * both surfaces are covered.
 */
import type { MouseEvent } from 'react-native';

declare module 'react-native' {
  interface ViewProps {
    onContextMenu?: ((e: MouseEvent) => void) | undefined;
  }
}
