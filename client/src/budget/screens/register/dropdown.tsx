/**
 * dropdown — shared portal-dropdown shell for the register. Extracted from the
 * approved PayeeDropdown recipe (itself cloned from core/ui/combobox): a text
 * input whose open dropdown renders in a body-level web portal anchored to the
 * measured input rect, escaping sibling-row stacking contexts and the register
 * ScrollView transform. Consumers: DatePickerPopover, AccountDropdown,
 * CategoryDropdown. React Native primitives only — identical rendering on web
 * (react-native-web) and iOS.
 */
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewInstance,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { colors } from '../../ui/theme';
import { createPortalOnWeb } from '@/ui/portal';

/** Anchored portal rect, in document coordinates plus viewport edges for flip-up. */
export interface DropdownAnchor {
  left: number;
  top: number;
  width: number;
  topVp: number;
  bottomVp: number;
  /** Anchor sits inside a fixed-position layer (e.g. OverlaySheet's Modal): viewport coords must NOT be scroll-compensated. */
  fixed?: boolean;
}

/**
 * Pressable prop bundle for portal controls that must not steal focus
 * (calendar arrows, footer action buttons): preventDefault on the raw
 * mousedown stops the browser's default focus shift, so the host input
 * keeps focus and the 120ms blur-close can't unmount the portal before
 * the press lands. react-native-web forwards onMouseDown to the DOM at
 * runtime, but PressableProps doesn't declare it — hence the cast.
 */
export const pressNoBlur = {
  onMouseDown: (e: { preventDefault: () => void }) => {
    e.preventDefault();
  },
} as unknown as { onMouseDown?: (e: { preventDefault: () => void }) => void };

/**
 * Measures the anchor container and keeps the rect fresh while open. Rows pick
 * on press-in, so `blurClose`'s small delay lets a press land before the
 * input's blur fallback closes the menu.
 */
export function useDropdownPortal(open: boolean, close: () => void) {
  const containerRef = useRef<ViewInstance>(null);
  const [anchor, setAnchor] = useState<DropdownAnchor | null>(null);

  const measureAnchor = useCallback(() => {
    if (process.env.EXPO_OS !== 'web') return;
    const node = containerRef.current as unknown as HTMLElement | null;
    const rect = node?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0) return;
    const left = rect.left + window.scrollX;
    const top = rect.bottom + window.scrollY;
    const fixed = (() => {
      for (let p = node?.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).position === 'fixed') return true;
      }
      return false;
    })();
    setAnchor((prev) =>
      prev &&
      prev.left === left &&
      prev.top === top &&
      prev.width === rect.width &&
      prev.topVp === rect.top &&
      prev.bottomVp === rect.bottom &&
      prev.fixed === fixed
        ? prev
        : { left, top, width: rect.width, topVp: rect.top, bottomVp: rect.bottom, fixed },
    );
  }, []);

  useLayoutEffect(() => {
    if (open) measureAnchor();
  }, [measureAnchor, open]);

  useEffect(() => {
    if (process.env.EXPO_OS !== 'web' || !open) return;
    window.addEventListener('scroll', measureAnchor, { capture: true });
    window.addEventListener('resize', measureAnchor);
    return () => {
      window.removeEventListener('scroll', measureAnchor, { capture: true });
      window.removeEventListener('resize', measureAnchor);
    };
  }, [measureAnchor, open]);

  const blurClose = useCallback(() => {
    setTimeout(close, 120);
  }, [close]);

  return { containerRef, anchor, blurClose };
}

/** Keyboard event shape shared by the register pickers. */
export interface DropdownKeyEvent {
  nativeEvent: { key: string };
  preventDefault: () => void;
}

/**
 * DropdownShell — the register dropdown frame: relative container, the input
 * (with optional chevron), and the portal-rendered menu (`children` above an
 * optional pinned `footer`) flipped up when viewport space runs out. Native
 * (non-web) falls back to an absolutely-positioned dropdown under the input.
 */
export function DropdownShell({
  open,
  anchor,
  value,
  onChangeText,
  onFocus,
  onBlur,
  onKeyPress,
  placeholder,
  placeholderTextColor = colors.faint,
  chevron,
  style,
  containerStyle,
  accessibilityLabel,
  children,
  footer,
  portalMinWidth = 260,
  portalMaxHeight = 240,
  nativeMaxHeight = 240,
  scroll = true,
}: {
  open: boolean;
  anchor: DropdownAnchor | null;
  value: string;
  onChangeText: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyPress?: (e: DropdownKeyEvent) => void;
  placeholder?: string;
  placeholderTextColor?: string;
  chevron?: boolean;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
  portalMinWidth?: number;
  portalMaxHeight?: number;
  nativeMaxHeight?: number;
  scroll?: boolean;
}) {
  const host = process.env.EXPO_OS === 'web' && typeof document !== 'undefined' ? document.body : null;

  // Flip up when there is no room below (menus paint above sibling rows — the
  // register dropdown z-order issue syscd-app-9q7).
  const portalPlacement = () => {
    if (!anchor) return null;
    const spaceBelow = window.innerHeight - anchor.bottomVp;
    const flipUp = spaceBelow < 200 && anchor.topVp > spaceBelow;
    const maxHeight = Math.max(160, Math.min(portalMaxHeight, (flipUp ? anchor.topVp : spaceBelow) - 8));
    // Inside a fixed layer (OverlaySheet's Modal) the page scroll never moves
    // the anchor, so viewport coords go in directly — no scroll compensation.
    if (anchor.fixed) {
      return flipUp
        ? {
            position: 'fixed' as const,
            left: anchor.left,
            bottom: window.innerHeight - anchor.topVp + 2,
            width: Math.max(anchor.width, portalMinWidth),
            maxHeight,
          }
        : {
            position: 'fixed' as const,
            left: anchor.left,
            top: anchor.bottomVp,
            width: Math.max(anchor.width, portalMinWidth),
            maxHeight,
          };
    }
    return flipUp
      ? {
          left: anchor.left,
          bottom: document.documentElement.scrollHeight - (anchor.topVp + window.scrollY) + 2,
          width: Math.max(anchor.width, portalMinWidth),
          maxHeight,
        }
      : {
          left: anchor.left,
          top: anchor.top,
          width: Math.max(anchor.width, portalMinWidth),
          maxHeight,
        };
  };

  const dropdown =
    open && anchor && host && createPortalOnWeb
      ? createPortalOnWeb(
          <View style={[styles.dropdownPortal, portalPlacement()]} testID="register-popover">
            {scroll ? (
              <ScrollView style={styles.listScroll}>{children}</ScrollView>
            ) : (
              <View style={styles.listStatic}>{children}</View>
            )}
            {footer}
          </View>,
          host,
        )
      : null;

  const nativeDropdown =
    open && !dropdown ? (
      <View style={[styles.dropdownNative, { maxHeight: nativeMaxHeight }]}>
        {scroll ? <ScrollView style={styles.listScroll}>{children}</ScrollView> : <View style={styles.listStatic}>{children}</View>}
        {footer}
      </View>
    ) : null;

  return (
    <View style={[styles.container, containerStyle]}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyPress={onKeyPress}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        blurOnSubmit={false}
        accessibilityLabel={accessibilityLabel}
        style={[styles.input, chevron && styles.inputChevron, style]}
      />
      {chevron ? (
        <View style={styles.chevronWrap}>
          <Text style={styles.chevronText}>{open ? '▲' : '▼'}</Text>
        </View>
      ) : null}
      {nativeDropdown}
      {dropdown}
    </View>
  );
}

/** Shared section-header + row styles for the register dropdowns. */
export const dropdownStyles = StyleSheet.create({
  sectionTitle: {
    color: colors.faint,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 10,
    minHeight: 28,
  },
  rowActive: { backgroundColor: colors.hover },
  rowStaticSelected: { backgroundColor: colors.hover },
  rowLabel: { color: colors.text, fontSize: 13, flexShrink: 1 },
  rowSub: { color: colors.faint, fontSize: 11 },
  rowAmount: { marginLeft: 'auto', flexShrink: 0, fontSize: 12, color: colors.text },
  amountNegative: { color: colors.redFg },
  amountPositive: { color: colors.green },
  amountZero: { color: colors.faint },
  check: { color: colors.indigo2, fontSize: 12, fontWeight: '700', width: 14 },
  checkPlaceholder: { width: 14 },
  pinnedRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pinnedLabel: { color: colors.indigo2, fontWeight: '600' },
  emptyRow: { color: colors.faint, fontSize: 12, paddingVertical: 6, paddingHorizontal: 10 },
});

const styles = StyleSheet.create({
  container: { position: 'relative', zIndex: 30 },
  input: {
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 9,
    color: colors.text,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 13,
    minWidth: 0,
  },
  inputChevron: { paddingRight: 24 },
  dropdownNative: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    zIndex: 40,
    marginTop: 2,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 9,
    overflow: 'hidden',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  dropdownPortal: {
    // Above OverlaySheet's RN-web Modal layer (z-index 9999) so dropdowns work
    // inside modal sheets, e.g. MoveMoneySheet's To picker (syscd-app-aey).
    position: 'absolute',
    zIndex: 10000,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 9,
    overflow: 'hidden',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
  },
  listScroll: { flexGrow: 0 },
  listStatic: {},
  chevronWrap: { position: 'absolute', right: 8, top: 0, bottom: 0, justifyContent: 'center' },
  chevronText: { color: colors.faint, fontSize: 12 },
});

/** Sign-colored style for an Available amount in a dropdown row (category menus, Move Money "To"). */
export function amountStyle(cents: number) {
  return cents > 0 ? dropdownStyles.amountPositive : cents < 0 ? dropdownStyles.amountNegative : dropdownStyles.amountZero;
}
