/**
 * react-native-web supports `onContextMenu` on Pressable/View (used for the
 * right-click category menu on the plan grid, syscd-app-42c) but RN 0.81's
 * shipped types don't surface it. Augment the same `PointerEvents` interface
 * RN uses for `onPointerDown` so the web-only prop typechecks and stays
 * native-safe (never fired on device).
 */
import type { PointerEvent } from 'react-native';

declare module 'react-native' {
  interface PointerEvents {
    onContextMenu?: ((event: PointerEvent) => void) | undefined;
  }
}
