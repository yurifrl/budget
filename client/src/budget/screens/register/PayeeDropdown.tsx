/**
 * PayeeDropdown — YNAB-style payee picker for the register (issue
 * syscd-app-da2). Sections top to bottom: "Selected" (current payee,
 * checkmark), "Payments and Transfers" (one row per budget account — commits
 * YNAB's "Transfer : <name>" payee naming), "Saved Payees" (GET /payees,
 * hidden payees excluded), and a pinned "Manage Payees…" row that navigates
 * to the Manage Payees page (budget/payees).
 *
 * Search-as-you-type filters rows (a query matching nothing offers a
 * "Use … as payee" row, same as the core Combobox). On web the open dropdown
 * renders in a body-level portal anchored to the measured input rect — the
 * core/ui/combobox pattern that escapes sibling-row stacking contexts and the
 * ScrollView transform, so this stays paintable above every register row.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle, type ViewInstance, type ViewStyle } from 'react-native';
import type { PayeeAdminRow } from '../../data/rows';
import type { Account } from '../../domain/types';
import { colors, radius } from '../../ui/theme';
import { createPortalOnWeb } from '@/ui/portal';
import { ManagePayeesModal } from '../ManagePayeesModal';
import { transferPayeeName } from '@shared/domain/transfers';

export { transferPayeeName };

type ItemKind = 'selected' | 'transfer' | 'payee';

interface Item {
  kind: ItemKind;
  key: string;
  label: string;
  sub?: string;
  /** The payee string committed into the field when picked. */
  commit: string;
  checked?: boolean;
}

interface Section {
  title: string;
  items: Item[];
}

export function PayeeDropdown({
  value,
  onChangeText,
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
  onChangeText: (text: string) => void;
  /** Payees from GET /payees; hidden ones vanish from Saved Payees. */
  payees: PayeeAdminRow[];
  /** Budget accounts driving the Payments and Transfers section. */
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
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number; topVp: number; bottomVp: number } | null>(null);

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
      prev &&
      prev.left === left &&
      prev.top === top &&
      prev.width === rect.width &&
      prev.topVp === rect.top &&
      prev.bottomVp === rect.bottom
        ? prev
        : { left, top, width: rect.width, topVp: rect.top, bottomVp: rect.bottom },
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
  const trimmedValue = value.trim();

  const sections = useMemo<Section[]>(() => {
    const transferItems: Item[] = accounts
      .filter((a) => a.id !== currentAccountId)
      .map((a) => ({
        kind: 'transfer' as const,
        key: `transfer:${a.id}`,
        label: transferPayeeName(a.name),
        sub: a.group === 'CASH' ? 'Cash account' : a.group === 'CREDIT' ? 'Credit account' : 'Account',
        commit: transferPayeeName(a.name),
      }));
    const payeeItems: Item[] = payees
      .filter((p) => !p.hidden)
      .map((p) => ({
        kind: 'payee' as const,
        key: `payee:${p.id}`,
        label: p.name,
        commit: p.name,
      }));

    const matches = (s: string) => s.toLowerCase().includes(query);
    const filterItems = (list: Item[]) => (query ? list.filter((i) => matches(i.label)) : list);

    const visiblePayee = payees.find((p) => !p.hidden && p.name === trimmedValue);
    // A selected transfer (committed from Payments and Transfers, or an
    // existing "Transfer : <account>" transaction being edited) shows under
    // Selected too — including a transfer to the current account, which the
    // option list omits but the field can still hold.
    const visibleTransfer = accounts.find((a) => transferPayeeName(a.name) === trimmedValue);
    const selectedRow: Item | null = visiblePayee
      ? { kind: 'selected' as const, key: 'selected', label: visiblePayee.name, commit: visiblePayee.name, checked: true }
      : visibleTransfer
        ? {
            kind: 'selected' as const,
            key: 'selected-transfer',
            label: transferPayeeName(visibleTransfer.name),
            commit: transferPayeeName(visibleTransfer.name),
            checked: true,
          }
        : null;
    const selectedSection: Section | null = selectedRow ? { title: 'Selected', items: [selectedRow] } : null;

    const transfers = filterItems(transferItems);
    const saved = filterItems(payeeItems);
    return [
      ...(selectedSection ? [selectedSection] : []),
      ...(transfers.length ? [{ title: 'Payments and Transfers', items: transfers }] : []),
      ...(saved.length ? [{ title: 'Saved Payees', items: saved }] : []),
    ];
  }, [accounts, currentAccountId, payees, query, trimmedValue]);

  // Flat pick list for keyboard highlight: section rows, then the create row
  // (typed queries matching no option) and Manage Payees.
  const flatRows: Item[] = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const hasExactMatch = useMemo(
    () => query.length > 0 && (flatRows.some((r) => r.label.toLowerCase() === query) || trimmedValue.length === 0),
    [flatRows, query, trimmedValue],
  );
  // +1 create row (typed query with no exact match), +1 Manage Payees row.
  const rowCount = flatRows.length + (query && !hasExactMatch ? 1 : 0) + 1;
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
    (item: Item) => {
      setOpen(false);
      setHighlight(0);
      onChangeText(item.commit);
    },
    [onChangeText],
  );

  const dropdownContent: ReactNode[] = [];
  let flatIndex = 0;
  for (const section of sections) {
    dropdownContent.push(
      <Text key={`hdr:${section.title}`} style={styles.sectionTitle}>
        {section.title}
      </Text>,
    );
    for (const item of section.items) {
      const i = flatIndex;
      const active = i === highlightedIndex;
      dropdownContent.push(
        <Pressable
          key={item.key}
          onPressIn={() => commitItem(item)}
          onHoverIn={() => setHighlight(i)}
          style={[styles.row, active && styles.rowActive]}>
          {item.checked ? <Text style={styles.check}>✓</Text> : <Text style={styles.checkPlaceholder} />}
          <Text style={styles.rowLabel} numberOfLines={1}>
            {item.label}
          </Text>
          {item.sub ? <Text style={styles.rowSub}>{item.sub}</Text> : null}
        </Pressable>,
      );
      flatIndex += 1;
    }
  }
  if (query && !hasExactMatch) {
    const i = flatIndex;
    const active = i === highlightedIndex;
    dropdownContent.push(
      <Pressable
        key="__create__"
        onPressIn={() => {
          setOpen(false);
          setHighlight(0);
          onChangeText(trimmedValue);
        }}
        onHoverIn={() => setHighlight(i)}
        style={[styles.row, active && styles.rowActive]}>
        <Text style={styles.checkPlaceholder} />
        <Text style={[styles.rowLabel, styles.createMark]}>＋</Text>
        <Text style={[styles.rowLabel, styles.createLabel]} numberOfLines={1}>
          {`Use “${trimmedValue}” as payee`}
        </Text>
      </Pressable>,
    );
    flatIndex += 1;
  }
  const iManage = flatIndex;
  const manageActive = iManage === highlightedIndex;
  // Pinned footer (YNAB): always visible below the scrollable list, never
  // clipped by the portal's maxHeight.
  const manageRow = (
    <Pressable
      key="__manage__"
      onPressIn={goManagePayees}
      onHoverIn={() => setHighlight(iManage)}
      style={[styles.row, styles.manageRow, manageActive && styles.rowActive]}
      testID="manage-row-v2">
      <Text style={styles.checkPlaceholder} />
      <Text style={[styles.rowLabel, styles.manageLabel]}>Manage Payees…</Text>
    </Pressable>
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
      setHighlight((h) => Math.min(h + 1, rowCount - 1));
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (key === 'Enter') {
      e.preventDefault();
      if (!open) return;
      // Enter below the section rows picks create (typed query) or closes via
      // Manage Payees only when highlighted — mirror the core Combobox, where
      // Enter picks the highlighted row.
      if (highlightedIndex < flatRows.length) {
        const item = flatRows[highlightedIndex];
        if (item) commitItem(item);
      } else if (query && !hasExactMatch && highlightedIndex === flatRows.length) {
        setOpen(false);
        setHighlight(0);
        onChangeText(trimmedValue);
      } else {
        goManagePayees();
      }
    } else if (key === 'Escape') {
      setOpen(false);
    }
  };

  // Viewport-aware portal placement: flip above the input when there's no
  // room below for a useful dropdown (short windows), and cap the height to
  // the available space so the pinned Manage Payees row stays on-screen.
  // Web-only: the native dropdown keeps its in-place absolute layout.
  const portalPlacement = () => {
    if (!anchor) return null;
    const spaceBelow = window.innerHeight - anchor.bottomVp;
    const flipUp = spaceBelow < 200 && anchor.topVp > spaceBelow;
    const maxHeight = Math.max(160, Math.min(240, (flipUp ? anchor.topVp : spaceBelow) - 8));
    return flipUp
      ? {
          left: anchor.left,
          bottom: document.documentElement.scrollHeight - (anchor.topVp + window.scrollY) + 2,
          width: Math.max(anchor.width, 260),
          maxHeight,
        }
      : { left: anchor.left, top: anchor.top, width: Math.max(anchor.width, 260), maxHeight };
  };

  return (
    <View ref={containerRef} style={[styles.container, containerStyle]}>
      <TextInput
        value={value}
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
            <ScrollView style={styles.listScroll} keyboardShouldPersistTaps="handled">
              {dropdownContent}
            </ScrollView>
            {manageRow}
          </View>,
          portalHost,
        )
      ) : open ? (
        // Native: in-place absolute dropdown (portals are web-only).
        <View style={styles.dropdown}>
          <ScrollView style={styles.listScroll} keyboardShouldPersistTaps="handled">
            {dropdownContent}
          </ScrollView>
          {manageRow}
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
  // Scrollable body inside the portal: sections + create row. The Manage
  // Payees footer sits below it, pinned outside the maxHeight clip.
  listScroll: { maxHeight: 212, flexShrink: 1 },
  sectionTitle: {
    color: colors.faint,
    fontSize: 11,
    fontWeight: '700',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
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
  createLabel: { color: colors.indigo2 },
  check: { color: colors.indigo2, fontSize: 12, fontWeight: '700', width: 12 },
  checkPlaceholder: { width: 12 },
  manageRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  manageLabel: { color: colors.indigo2, fontWeight: '600' },
  inputChevron: { paddingRight: 24 },
  chevronWrap: { position: 'absolute', right: 8, top: 0, bottom: 0, justifyContent: 'center' },
  chevronText: { color: colors.faint, fontSize: 12 },
});
