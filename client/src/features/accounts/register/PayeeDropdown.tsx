/**
 * PayeeDropdown — YNAB-style payee picker for the register (issue
 * syscd-app-da2). Sections top to bottom: "Selected" (current payee,
 * checkmark), "Payments and Transfers" (the transfer payee of each open
 * account but the row's own: THE way to make a transfer), "Saved Payees"
 * (GET /payees, hidden payees excluded), and a pinned "Manage Payees…" row that navigates
 * to the Manage Payees page (budget/payees).
 *
 * Search-as-you-type filters rows (a query matching nothing offers a
 * "Use … as payee" row, same as the core Combobox). On web the open dropdown
 * renders in a body-level portal anchored to the measured input rect — the
 * core/ui/combobox pattern that escapes sibling-row stacking contexts and the
 * ScrollView transform, so this stays paintable above every register row.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle, type ViewInstance, type ViewStyle } from 'react-native';
import type { PayeeAdminRow } from '@/budget/data/rows';
import { displaySystemName } from '@/domain/systemNames';
import type { Account } from '@/domain/types';
import { colors, radius } from '@/ui/theme';
import { createPortalOnWeb } from '@/ui/portal';
import { ManagePayeesModal } from '@/features/payees';
import {
  anchorFromRect,
  enterTarget,
  highlightAfterKey,
  payeeMenu,
  payeePortalPlacement,
  payeeSections,
  type PayeeAnchor,
  type PayeeItem,
} from './payeeDropdown.logic';
import { PayeeMenuBody } from './PayeeMenuBody';


export function PayeeDropdown({
  value,
  onChangeText,
  onPickPayee,
  payeeId,
  payees,
  accounts,
  currentAccountId,
  placeholder,
  chevron,
  style,
  containerStyle,
  accessibilityLabel,
}: {
  /** Controlled display text (the payee name, as in the core Combobox). */
  value: string;
  /** Typed text (a new name, or any text): the payee is resolved by name. */
  onChangeText: (text: string) => void;
  /** A pick from the list: an existing payee (ordinary or an account's transfer payee) by id. */
  onPickPayee?: (payee: { id: string; name: string }) => void;
  /** The picked payee's id while the field holds one (marks it Selected). */
  payeeId?: string | null;
  /** Payees WITH the accounts' transfer payees (include_transfers); hidden ones vanish from Saved Payees. */
  payees: PayeeAdminRow[];
  /** Budget accounts: which transfer payees "Payments and Transfers" offers. */
  accounts: Account[];
  /** Row's transaction account — its own transfer row is omitted (no self-transfer). */
  currentAccountId?: string | null;
  placeholder?: string;
  chevron?: boolean;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Manage Payees opens in place — programmatic router navigation to the tab
  // root (`/`, the modal's deep-link mount) is resolved back to the
  // active screen and silently no-ops from a child tab screen (expo-router
  // ~6) — only sibling tab screens are addressable.
  const [manageOpen, setManageOpen] = useState(false);
  const containerRef = useRef<ViewInstance>(null);
  // Web portal anchor: document-space rect (left/top/width) of the container.
  // Null on native, which keeps the in-place absolute dropdown.
  const [anchor, setAnchor] = useState<PayeeAnchor | null>(null);

  const measureAnchor = useCallback(() => {
    if (process.env.EXPO_OS !== 'web') return;
    const node = containerRef.current as unknown as HTMLElement | null; // RNW forwards the View ref to its host element
    const rect = node?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0) return;
    setAnchor((prev) => anchorFromRect(prev, rect, window.scrollX, window.scrollY));
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

  const trimmedValue = value.trim();

  const sections = useMemo(
    () => payeeSections({ accounts, currentAccountId, payees, value, payeeId }),
    [accounts, currentAccountId, payees, value, payeeId],
  );
  // Flat pick list for keyboard highlight: section rows, then the create row
  // (typed queries matching no option) and Manage Payees.
  const menu = useMemo(() => payeeMenu(sections, value), [sections, value]);
  const { rowCount } = menu;
  const highlightedIndex = Math.min(highlight, rowCount - 1);

  const blurClose = () => {
    // Rows pick on press-in (mousedown), so a pick lands before this fallback
    // close; the delay also lets press-in win over blur.
    setTimeout(() => setOpen(false), 120);
  };

  const goManagePayees = useCallback(() => {
    setOpen(false);
    setManageOpen(true);
  }, []);

  const commitItem = useCallback(
    (item: PayeeItem) => {
      setOpen(false);
      setHighlight(0);
      if (item.payeeId && onPickPayee) onPickPayee({ id: item.payeeId, name: item.commit });
      else onChangeText(item.commit);
    },
    [onChangeText, onPickPayee],
  );

  const commitTyped = () => {
    setOpen(false);
    setHighlight(0);
    onChangeText(trimmedValue);
  };

  const menuBody = (
    <PayeeMenuBody
      sections={sections}
      showCreate={menu.showCreate}
      createLabel={trimmedValue}
      highlightedIndex={highlightedIndex}
      onHighlight={setHighlight}
      onPick={commitItem}
      onCreate={commitTyped}
      onManage={goManagePayees}
    />
  );

  // Portal mount point. body is static in RN-web, so document-anchored
  // coordinates track page scroll; inner ScrollView scroll re-anchors via the
  // capture listener above.
  const portalHost = process.env.EXPO_OS === 'web' ? document.body : null;

  const onInputKeyPress = (e: { nativeEvent: { key: string }; preventDefault: () => void }) => {
    const key = e.nativeEvent.key;
    if (key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => highlightAfterKey(h, 'ArrowDown', rowCount));
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => highlightAfterKey(h, 'ArrowUp', rowCount));
    } else if (key === 'Enter') {
      e.preventDefault();
      if (!open) return;
      // Enter below the section rows picks create (typed query) or closes via
      // Manage Payees only when highlighted — mirror the core Combobox, where
      // Enter picks the highlighted row.
      const target = enterTarget(highlightedIndex, menu);
      if (target.kind === 'item') commitItem(target.item);
      else if (target.kind === 'create') commitTyped();
      else if (target.kind === 'manage') goManagePayees();
    } else if (key === 'Escape') {
      setOpen(false);
    }
  };

  // Viewport-aware portal placement (flip above / cap the height).
  // Web-only: the native dropdown keeps its in-place absolute layout.
  const portalPlacement = () =>
    anchor
      ? payeePortalPlacement(anchor, {
          innerHeight: window.innerHeight,
          scrollY: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
        })
      : null;

  return (
    <View ref={containerRef} style={[styles.container, containerStyle]}>
      <TextInput
        // A stored system name ("Starting Balance") shows in the active language; the stored text stays the value.
        value={displaySystemName(value)}
        onChangeText={(t) => {
          onChangeText(t);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={blurClose}
        onKeyPress={onInputKeyPress}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        blurOnSubmit={false}
        style={[styles.input, chevron && styles.inputChevron, style]}
        accessibilityLabel={accessibilityLabel}
      />
      {chevron ? (
        <View pointerEvents="none" style={styles.chevronWrap}>
          <Text style={styles.chevronText}>⌄</Text>
        </View>
      ) : null}
      {open && anchor && createPortalOnWeb && portalHost ? (
        // Web: body-level portal escapes every ancestor stacking context and
        // the ScrollView transform, so the dropdown paints above all rows.
        createPortalOnWeb(
          <View style={[styles.dropdownPortal, portalPlacement()]} testID="register-popover">
            {menuBody}
          </View>,
          portalHost,
        )
      ) : open ? (
        // Native: in-place absolute dropdown (portals are web-only).
        <View style={styles.dropdown}>
          {menuBody}
        </View>
      ) : null}
      {manageOpen ? <ManagePayeesModal visible={manageOpen} onClose={() => setManageOpen(false)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative', zIndex: 30 },
  input: {
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
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
    maxHeight: 240,
    overflow: 'hidden',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    zIndex: 40,
    elevation: 8,
  },
  // Portal twin of `dropdown` for the body-level web render: anchored via
  // inline left/top/width, stacked above the app chrome (header 30 / scrim
  // 40 / drawer 41) that sibling rows can't escape.
  dropdownPortal: {
    position: 'absolute',
    maxHeight: 240,
    overflow: 'hidden',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    zIndex: 60,
    elevation: 8,
  },
  inputChevron: { paddingRight: 24 },
  chevronWrap: { position: 'absolute', right: 8, top: 0, bottom: 0, justifyContent: 'center' },
  chevronText: { color: colors.faint, fontSize: 12 },
});
