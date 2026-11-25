/**
 * Combobox — a text input with a filtered dropdown: search, pick, create.
 * Shared primitive (core/ui): the budget register's inline add row uses it
 * for account / payee / category; reusable by any module. React Native
 * primitives only — identical rendering on web (react-native-web) and iOS.
 *
 * On web the open dropdown renders in a body-level portal, anchored to the
 * measured input rect. react-native-web gives every view
 * `position: relative; z-index: 0`, so each register row cell is its own
 * stacking context and a plain absolute dropdown gets painted over by later
 * sibling rows; the ScrollView's transform also defeats position: fixed.
 * The portal escapes both. Native keeps the in-place dropdown (elevation
 * and z-index work there).
 *
 * Options filter case-insensitively by substring; when `onCreate` is given,
 * a "create" action appears for typed queries that match no option exactly.
 * Keyboard: ↑/↓ move the highlight, Enter picks, Esc closes.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputInstance,
  type ViewInstance,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { colors, radius } from './theme';
import { createPortalOnWeb } from './portal';
import { t } from './text/i18n';

export interface ComboboxOption {
  key: string;
  label: string;
  sub?: string;
  /** Extra text the typed query also matches (e.g. the stored name behind a translated label). */
  searchText?: string;
}

export function Combobox({
  value,
  onChangeText,
  options,
  onPick,
  onCreate,
  createLabel,
  placeholder,
  chevron,
  pickOnly,
  autoFocus,
  inputRef,
  style,
  containerStyle,
  accessibilityLabel,
}: {
  /** Controlled display text. */
  value: string;
  onChangeText: (text: string) => void;
  options: ComboboxOption[];
  /** Called with the picked option's key. */
  onPick: (key: string) => void;
  /** Enables the "create" row for queries matching no option; receives the raw query. */
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => string;
  placeholder?: string;
  /** Select-affordance glyph (⌄) pinned at the right edge — pick-style cells. */
  chevron?: boolean;
  /** A pick-style cell: every option is listed whatever the text says (the text is the current choice, not a search). */
  pickOnly?: boolean;
  autoFocus?: boolean;
  /** The text input's ref, for callers that focus it from a shortcut ("/"). */
  inputRef?: Ref<TextInputInstance>;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<ViewInstance>(null);
  // Web portal anchor: viewport rect of the container, left/top/width. Null on
  // native, which keeps the in-place absolute dropdown.
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);

  const measureAnchor = useCallback(() => {
    if (process.env.EXPO_OS !== 'web') return;
    const node = containerRef.current as unknown as HTMLElement | null; // RNW forwards the View ref to its host element
    const rect = node?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0) return;
    // Document coordinates: body is static in RN-web, so a body-level
    // absolute dropdown stays glued to the input across page scroll.
    const left = rect.left + window.scrollX;
    const top = rect.bottom + window.scrollY;
    setAnchor((prev) =>
      prev && prev.left === left && prev.top === top && prev.width === rect.width
        ? prev
        : { left, top, width: rect.width },
    );
  }, []);

  useLayoutEffect(() => {
    if (open) measureAnchor();
  }, [measureAnchor, open]);

  // Follow the input while the register scrolls or the window resizes; the
  // ScrollView's scroll events don't bubble, hence the capture listener.
  useEffect(() => {
    if (process.env.EXPO_OS !== 'web' || !open) return;
    window.addEventListener('scroll', measureAnchor, { capture: true });
    window.addEventListener('resize', measureAnchor);
    return () => {
      window.removeEventListener('scroll', measureAnchor, { capture: true });
      window.removeEventListener('resize', measureAnchor);
    };
  }, [measureAnchor, open]);

  const query = value.trim().toLowerCase();
  const filtered = useMemo(
    () => (query && !pickOnly ? options.filter((o) => o.label.toLowerCase().includes(query) || o.searchText?.toLowerCase().includes(query)) : options),
    [options, query, pickOnly],
  );
  const canCreate =
    onCreate != null && query.length > 0 && !options.some((o) => o.label.toLowerCase() === query);

  const items: ({ kind: 'option'; option: ComboboxOption; index: number } | { kind: 'create' })[] = [
    ...filtered.map((option, index) => ({ kind: 'option' as const, option, index })),
    ...(canCreate ? [{ kind: 'create' as const }] : []),
  ];
  const highlighted = items[highlight];

  const pick = (item: (typeof items)[number]) => {
    setOpen(false);
    setHighlight(0);
    if (item.kind === 'option') onPick(item.option.key);
    else onCreate?.(value.trim());
  };

  // Rows pick on press-in (mousedown / touchstart) so a pick lands before the
  // input's blur closes the dropdown; blur also schedules a close as a fallback.
  const blurClose = () => {
    setTimeout(() => setOpen(false), 120);
  };

  const dropdownRows = items.map((item, i) => (
    <Pressable
      key={item.kind === 'option' ? item.option.key : '__create__'}
      onPressIn={() => pick(item)}
      // Web: the dropdown mounts on document.body, and RN-web's press
      // responder doesn't engage for clicks in portals — pick on the native
      // pointerdown (same fix as MoveMoneySheet, syscd-app-aey).
      onPointerDown={() => pick(item)}
      onHoverIn={() => setHighlight(i)}
      style={[styles.row, i === highlight && styles.rowActive]}
    >
      {item.kind === 'option' ? (
        <>
          <Text style={styles.rowLabel} numberOfLines={1}>
            {item.option.label}
          </Text>
          {item.option.sub ? <Text style={styles.rowSub}>{item.option.sub}</Text> : null}
        </>
      ) : (
        <>
          <Text style={[styles.rowLabel, styles.createMark]}>＋</Text>
          <Text style={[styles.rowLabel, { color: colors.indigo2 }]} numberOfLines={1}>
            {createLabel ? createLabel(value.trim()) : t('combobox.create', { query: value.trim() })}
          </Text>
        </>
      )}
    </Pressable>
  ));

  // Portal mount point. body is static in RN-web, so document-anchored
  // coordinates track page scroll; inner ScrollView scroll re-anchors via the
  // capture listener above.
  const portalHost = process.env.EXPO_OS === 'web' ? document.body : null;

  return (
    <View ref={containerRef} style={[styles.container, containerStyle]}>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={(t) => {
          onChangeText(t);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={blurClose}
        onKeyPress={(e) => {
          const key = e.nativeEvent.key;
          if (key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, items.length - 1));
          } else if (key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (key === 'Enter') {
            e.preventDefault();
            if (open && highlighted) pick(highlighted);
          } else if (key === 'Escape') {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        autoFocus={autoFocus}
        blurOnSubmit={false}
        style={[styles.input, chevron && styles.inputChevron, style]}
        accessibilityLabel={accessibilityLabel}
      />
      {chevron ? (
        <View pointerEvents="none" style={styles.chevronWrap}>
          <Text style={styles.chevronText}>⌄</Text>
        </View>
      ) : null}
      {open && items.length > 0 && anchor && createPortalOnWeb && portalHost ? (
        // Web: body-level portal escapes every ancestor stacking context and
        // the ScrollView transform, so the dropdown paints correctly everywhere.
        createPortalOnWeb(
          <View style={[styles.dropdown, anchor]}>
            {dropdownRows}
          </View>,
          portalHost,
        )
      ) : open && items.length > 0 ? (
        // Native: in-place absolute dropdown (portals are web-only).
        <View style={styles.dropdown}>{dropdownRows}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative', zIndex: 30 },
  input: {
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.field6,
    color: colors.text,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 13,
  },
  dropdown: {
    position: 'absolute',
    top: 31,
    left: 0,
    right: 0,
    maxHeight: 220,
    overflow: 'hidden',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.field6,
    zIndex: 40,
    elevation: 8,
  },
  // Portal twin of `dropdown` for the body-level web render: anchored via
  // inline left/top/width, stacked above the app chrome (header 30 / scrim
  // 40 / drawer 41) that sibling rows can't escape.
  dropdownPortal: {
    position: 'absolute',
    maxHeight: 220,
    overflow: 'hidden',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.field6,
    zIndex: 60,
    elevation: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  rowActive: { backgroundColor: colors.hover },
  rowLabel: { color: colors.text, fontSize: 13, flexShrink: 1 },
  rowSub: { color: colors.faint, fontSize: 11 },
  createMark: { color: colors.indigo2, fontWeight: '700' },
  inputChevron: { paddingRight: 24 },
  chevronWrap: { position: 'absolute', right: 8, top: 0, bottom: 0, justifyContent: 'center' },
  chevronText: { color: colors.faint, fontSize: 12 },
});
