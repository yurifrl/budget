/**
 * AccountDropdown — YNAB-style account picker for the register ACCOUNT cell
 * (issue syscd-app-kfy). Sections top to bottom: "Selected" pinning the
 * current account (checkmark), then "Cash Accounts" and "Credit Accounts"
 * group sections with a checkmark on the current account in each. The input
 * filters group rows as you type; while the menu is open the cell keeps
 * showing the committed account name until a row is picked. Built on the
 * shared DropdownShell portal (syscd-app-9q7) so the menu paints above
 * sibling register rows.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { DropdownShell, dropdownStyles, useDropdownPortal, type DropdownKeyEvent } from './dropdown';

import type { Account, AccountGroup } from '@/domain/types';

interface Item {
  key: string;
  accountId: string;
  label: string;
  checked: boolean;
}

const SECTIONS: { title: string; group: AccountGroup }[] = [
  { title: 'Cash Accounts', group: 'CASH' },
  { title: 'Credit Accounts', group: 'CREDIT' },
];

export function AccountDropdown({
  accounts,
  currentAccountId,
  onPick,
  placeholder,
  chevron,
  style,
  containerStyle,
  accessibilityLabel,
}: {
  accounts: Account[];
  currentAccountId: string | null;
  onPick: (accountId: string) => void;
  placeholder?: string;
  chevron?: boolean;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [highlight, setHighlight] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const { containerRef, anchor, blurClose } = useDropdownPortal(open, close);

  const current = accounts.find((a) => a.id === currentAccountId) ?? null;
  const query = draft.trim().toLowerCase();

  // While open, the input holds the filter text; the committed name shows as
  // soon as the filter is empty or the menu is closed.
  const inputValue = open && draft !== '' ? draft : current?.name ?? '';

  const selected = useMemo<Item | null>(
    () => (current ? { key: '__selected__', accountId: current.id, label: current.name, checked: true } : null),
    [current],
  );
  const visible = useMemo(
    () =>
      SECTIONS.map(({ title, group }) => ({
        title,
        rows: accounts
          .filter((a) => a.group === group && (!query || a.name.toLowerCase().includes(query)))
          .map((a): Item => ({ key: a.id, accountId: a.id, label: a.name, checked: a.id === currentAccountId })),
      })),
    [accounts, query, currentAccountId],
  );
  const items = useMemo<Item[]>(
    () => [...(selected ? [selected] : []), ...visible.flatMap((s) => s.rows)],
    [selected, visible],
  );

  const commit = useCallback(
    (item: Item | undefined) => {
      if (!item) return;
      onPick(item.accountId);
      close();
    },
    [onPick, close],
  );

  const onKeyPress = useCallback(
    (e: DropdownKeyEvent) => {
      const key = e.nativeEvent.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        if (!open) {
          setDraft('');
          setHighlight(0);
          setOpen(true);
          return;
        }
        setHighlight((h) => (key === 'ArrowDown' ? Math.min(h + 1, items.length - 1) : Math.max(h - 1, 0)));
      } else if (key === 'Enter' && open) {
        e.preventDefault();
        commit(items[highlight]);
      } else if (key === 'Escape' && open) {
        e.preventDefault();
        close();
      }
    },
    [open, items, highlight, commit, close],
  );

  const rows: ReactNode[] = [];
  let flatIndex = 0;
  if (selected) {
    const i = flatIndex++;
    rows.push(
      <Text key="selected-hd" style={dropdownStyles.sectionTitle}>
        Selected
      </Text>,
      <Pressable
        key={selected.key}
        onPressIn={() => commit(selected)}
        onHoverIn={() => setHighlight(i)}
        style={[dropdownStyles.row, dropdownStyles.rowStaticSelected]}>
        <Text style={dropdownStyles.check}>✓</Text>
        <Text style={dropdownStyles.rowLabel} numberOfLines={1}>
          {selected.label}
        </Text>
      </Pressable>,
    );
  }
  let lastTitle: string | null = null;
  for (const section of visible) {
    if (!section.rows.length) continue;
    for (const item of section.rows) {
      if (lastTitle !== section.title) {
        rows.push(
          <Text key={section.title} style={dropdownStyles.sectionTitle}>
            {section.title.toUpperCase()}
          </Text>,
        );
        lastTitle = section.title;
      }
      const i = flatIndex++;
      rows.push(
        <Pressable
          key={item.key}
          onPressIn={() => commit(item)}
          onHoverIn={() => setHighlight(i)}
          style={[dropdownStyles.row, i === highlight && dropdownStyles.rowActive]}>
          {item.checked ? <Text style={dropdownStyles.check}>✓</Text> : <Text style={dropdownStyles.checkPlaceholder} />}
          <Text style={dropdownStyles.rowLabel} numberOfLines={1}>
            {item.label}
          </Text>
        </Pressable>,
      );
    }
  }
  if (query && rows.length === (selected ? 2 : 0)) {
    rows.push(<Text key="empty" style={dropdownStyles.emptyRow}>No accounts match “{draft.trim()}”</Text>);
  }

  return (
    <View ref={containerRef} style={[styles.cell, containerStyle]}>
      <DropdownShell
        open={open}
        anchor={anchor}
        value={inputValue}
        onChangeText={(t) => {
          setDraft(t);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => {
          setDraft('');
          setHighlight(0);
          setOpen(true);
        }}
        onBlur={blurClose}
        onKeyPress={onKeyPress}
        placeholder={placeholder}
        chevron={chevron}
        style={style}
        containerStyle={styles.cellInner}
        accessibilityLabel={accessibilityLabel}
        portalMinWidth={220}>
        {rows}
      </DropdownShell>
    </View>
  );
}

const styles = StyleSheet.create({
  cell: { position: 'relative', zIndex: 30 },
  cellInner: { position: 'relative' },
});
