/**
 * PayeeMenuBody — the open PayeeDropdown's contents: the scrollable section
 * rows (Selected / Payments and Transfers / Saved Payees), the "Use … as
 * payee" create row and the pinned "Manage Payees…" footer. Rows pick on
 * press-in (mousedown) so a pick lands before the input's blur closes the
 * dropdown.
 */

import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { colors } from '../../ui/theme';
import type { PayeeItem, PayeeSection } from './payeeDropdown.logic';

export function PayeeMenuBody({
  sections,
  showCreate,
  createLabel,
  highlightedIndex,
  onHighlight,
  onPick,
  onCreate,
  onManage,
}: {
  sections: readonly PayeeSection[];
  /** Offer the create row (typed query matching no option). */
  showCreate: boolean;
  /** The trimmed field text the create row commits. */
  createLabel: string;
  /** Keyboard/hover highlight over the flat row list (items, create, manage). */
  highlightedIndex: number;
  onHighlight: (index: number) => void;
  onPick: (item: PayeeItem) => void;
  onCreate: () => void;
  onManage: () => void;
}) {
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
          onPressIn={() => onPick(item)}
          onHoverIn={() => onHighlight(i)}
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
  if (showCreate) {
    const i = flatIndex;
    const active = i === highlightedIndex;
    dropdownContent.push(
      <Pressable
        key="__create__"
        onPressIn={onCreate}
        onHoverIn={() => onHighlight(i)}
        style={[styles.row, active && styles.rowActive]}>
        <Text style={styles.checkPlaceholder} />
        <Text style={[styles.rowLabel, styles.createMark]}>＋</Text>
        <Text style={[styles.rowLabel, styles.createLabel]} numberOfLines={1}>
          {`Use “${createLabel}” as payee`}
        </Text>
      </Pressable>,
    );
    flatIndex += 1;
  }
  const iManage = flatIndex;
  const manageActive = iManage === highlightedIndex;
  return (
    <>
      <ScrollView style={styles.listScroll} keyboardShouldPersistTaps="handled">
        {dropdownContent}
      </ScrollView>
      {/* Pinned footer (YNAB): always visible below the scrollable list, never
          clipped by the portal's maxHeight. */}
      <Pressable
        key="__manage__"
        onPressIn={onManage}
        onHoverIn={() => onHighlight(iManage)}
        style={[styles.row, styles.manageRow, manageActive && styles.rowActive]}
        testID="manage-row-v2">
        <Text style={styles.checkPlaceholder} />
        <Text style={[styles.rowLabel, styles.manageLabel]}>Manage Payees…</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
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
});
