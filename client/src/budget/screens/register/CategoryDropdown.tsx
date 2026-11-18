/**
 * CategoryDropdown — YNAB-style category picker for the register CATEGORY
 * cell (issue syscd-app-zcm). Category mode, top to bottom: a pinned "New
 * Category" action (creates through the cell's existing addCategory path and
 * assigns it), a "Selected" pin of the current category as "name (group)"
 * with its AVAILABLE amount, an "Inflow / Ready to Assign" row that commits
 * the uncategorized state (checkmark + pin when nothing is selected) with
 * the live Ready-to-Assign amount, then one section per category group with
 * each category's AVAILABLE amount right-aligned. The "Payment/Transfer"
 * footer switches the same menu into transfer mode — one row per budget
 * account; picking one commits the exact "Transfer : <name>" payee string
 * PayeeDropdown uses and clears the category. "Split" needs register split
 * support and is a documented prerequisite (see tk syscd-app-zcm).
 * Filter-as-you-type narrows group rows. Built on the shared DropdownShell
 * portal (syscd-app-9q7) so the menu paints above sibling register rows.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { DropdownShell, dropdownStyles, pressNoBlur, useDropdownPortal, type DropdownKeyEvent } from './dropdown';
import { transferPayeeName } from './PayeeDropdown';

import { categoryLabel } from '../../domain/bundles';
import { formatMoney } from '../../domain/format';
import type { Account, Bundle, Cents, Category, CategoryGroup } from '../../domain/types';
import { categoryFigures, type BudgetMonth } from '../../domain/zeroSum';
import { matchesCategoryQuery } from '../../ui/categoryPick';
import { colors } from '../../ui/theme';

interface Item {
  key: string;
  kind: 'create' | 'selected' | 'rta' | 'category' | 'transfer';
  /** Category id to commit (null = uncategorized/RTA); account id in transfer mode. */
  targetId: string | null;
  label: string;
  /** Owning group title — drives category section headers. */
  groupTitle?: string;
  checked: boolean;
}

/** Sign-colored amount style shared by every AVAILABLE readout in the menu. */
const amountStyle = (cents: Cents) =>
  cents > 0 ? dropdownStyles.amountPositive : cents < 0 ? dropdownStyles.amountNegative : dropdownStyles.amountZero;

export function CategoryDropdown({
  categories,
  groups,
  bundles = [],
  currentCategoryId,
  bm,
  accounts,
  payeeValue,
  onPick,
  onCreate,
  onTransferPick,
  onSplitPick,
  placeholder,
  chevron,
  style,
  containerStyle,
  accessibilityLabel,
}: {
  categories: Category[];
  groups: CategoryGroup[];
  /** Bundles: rows read "Bundle › Category"; search matches either. */
  bundles?: Bundle[];
  currentCategoryId: string | null;
  /** Live Ready-to-Assign pool shown by the Inflow / Ready to Assign row. */
  /** Month whose category AVAILABLE amounts are shown. */
  /** The engine's figures for the month the menu amounts are scoped to (Available per row, Ready to Assign). */
  bm: BudgetMonth;
  /** Budget accounts for transfer mode (Payment/Transfer footer). */
  accounts: Account[];
  /** Current payee text — marks which transfer row is already committed. */
  payeeValue?: string;
  onPick: (categoryId: string | null) => void;
  /** Creates a category from the current filter text and assigns it. */
  onCreate: (query: string) => void;
  /** Commits the picked account as the transaction's transfer payee. */
  onTransferPick: (accountId: string) => void;
  /** Opens the row's split editor (syscd-app-rlt). Omitted hides the Split footer button. */
  onSplitPick?: () => void;
  placeholder?: string;
  chevron?: boolean;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'category' | 'transfer'>('category');
  const [draft, setDraft] = useState('');
  const [highlight, setHighlight] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const { containerRef, anchor, blurClose } = useDropdownPortal(open, close);

  const current = categories.find((c) => c.id === currentCategoryId) ?? null;
  const currentGroup = current ? groups.find((g) => g.id === current.groupId) ?? null : null;
  const currentTransfer = payeeValue ? accounts.find((a) => transferPayeeName(a.name) === payeeValue) ?? null : null;
  const transfer = mode === 'transfer';
  const query = draft.trim().toLowerCase();
  // Spec: the "New Category" action is pinned at the top of category mode. It
  // only hides when the typed name already exists (nothing left to create);
  // with an empty draft it stays visible but the commit is a no-op.
  const creatable = !transfer && !categories.some((c) => c.name.toLowerCase() === query);
  // While open, the input holds the filter text; the committed name shows as
  // soon as the filter is empty or the menu is closed.
  const inputValue = open && draft !== '' ? draft : transfer ? currentTransfer?.name ?? '' : current ? categoryLabel(current, bundles) : '';

  // The transfer mode is a transient view of this menu: closing it (blur,
  // Esc, or a pick) returns the cell to the category list.
  useEffect(() => {
    if (!open && mode === 'transfer') setMode('category');
  }, [open, mode]);

  const items = useMemo<Item[]>(() => {
    const rows: Item[] = [];
    if (transfer) {
      for (const a of accounts) {
        if (query && !a.name.toLowerCase().includes(query)) continue;
        rows.push({ key: a.id, kind: 'transfer', targetId: a.id, label: a.name, checked: a.id === currentTransfer?.id });
      }
    } else {
      if (creatable) {
        rows.push({ key: '__create__', kind: 'create', targetId: null, label: 'New Category', checked: false });
      }
      if (current) {
        const groupName = groups.find((g) => g.id === current.groupId)?.name;
        rows.push({
          key: '__selected__',
          kind: 'selected',
          targetId: current.id,
          label: groupName ? `${categoryLabel(current, bundles)} (${groupName})` : categoryLabel(current, bundles),
          checked: true,
        });
      }
      rows.push({ key: '__rta__', kind: 'rta', targetId: null, label: 'Inflow / Ready to Assign', checked: currentCategoryId === null });
      for (const g of groups) {
        for (const cat of categories.filter((c) => c.groupId === g.id && matchesCategoryQuery(c, bundles, query))) {
          rows.push({ key: cat.id, kind: 'category', targetId: cat.id, label: categoryLabel(cat, bundles), groupTitle: g.name, checked: cat.id === currentCategoryId });
        }
      }
    }
    return rows;
  }, [transfer, accounts, query, creatable, current, groups, categories, bundles, currentTransfer, currentCategoryId]);

  const commit = useCallback(
    (item: Item | undefined) => {
      if (!item) return;
      if (item.kind === 'create') {
        const name = draft.trim();
        if (!name) return;
        onCreate(name);
      } else if (item.kind === 'transfer' && item.targetId) onTransferPick(item.targetId);
      else onPick(item.targetId);
      close();
    },
    [onCreate, onPick, onTransferPick, close, draft],
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
  let lastTitle: string | null = null;
  items.forEach((item, i) => {
    if (item.kind === 'selected') {
      rows.push(
        <Text key="selected-hd" style={dropdownStyles.sectionTitle}>
          Selected
        </Text>,
      );
    }
    const itemTitle = transfer ? 'Payments and Transfers' : item.groupTitle;
    if (itemTitle && lastTitle !== itemTitle) {
      lastTitle = itemTitle;
      rows.push(
        <Text key={itemTitle} style={dropdownStyles.sectionTitle}>
          {itemTitle.toUpperCase()}
        </Text>,
      );
    }
    const cat = item.kind === 'category' ? categories.find((c) => c.id === item.targetId) ?? null : null;
    const pinned = item.kind === 'selected' || (item.kind === 'rta' && currentCategoryId === null);
    rows.push(
      <Pressable
        key={item.key}
        onPressIn={() => commit(item)}
        onHoverIn={() => setHighlight(i)}
        style={[dropdownStyles.row, (pinned || i === highlight) && dropdownStyles.rowActive]}>
        {item.checked ? (
          <Text style={dropdownStyles.check}>✓</Text>
        ) : item.kind === 'create' ? (
          <Text style={dropdownStyles.checkPlaceholder}>✎</Text>
        ) : (
          <Text style={dropdownStyles.checkPlaceholder} />
        )}
        <Text
          style={[
            dropdownStyles.rowLabel,
            item.kind === 'create' && dropdownStyles.pinnedLabel,
            item.kind === 'selected' && styles.selectedLabel,
          ]}
          numberOfLines={1}>
          {item.kind === 'selected' && current ? `${categoryLabel(current, bundles)} (${currentGroup?.name ?? '—'})` : item.label}
        </Text>
        {item.kind === 'selected' && current ? (
          <Text style={[dropdownStyles.rowAmount, amountStyle(categoryFigures(bm, current.id).available)]}>
            {formatMoney(categoryFigures(bm, current.id).available)}
          </Text>
        ) : null}
        {item.kind === 'rta' ? (
          <Text style={[dropdownStyles.rowAmount, amountStyle(bm.readyToAssign)]}>{formatMoney(bm.readyToAssign)}</Text>
        ) : null}
        {cat ? (
          <Text style={[dropdownStyles.rowAmount, amountStyle(categoryFigures(bm, cat.id).available)]}>
            {formatMoney(categoryFigures(bm, cat.id).available)}
          </Text>
        ) : null}
      </Pressable>,
    );
  });
  if (query && items.length === 0) {
    rows.push(
      <Text key="empty" style={dropdownStyles.emptyRow}>
        No {transfer ? 'accounts' : 'categories'} match “{draft.trim()}”
      </Text>,
    );
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
        footer={
          <View style={styles.footerRow}>
            <Pressable
              onPressIn={() => {
                setMode('transfer');
                setDraft('');
                setHighlight(0);
              }}
              {...pressNoBlur}
              style={[dropdownStyles.pinnedRow, dropdownStyles.row, styles.footerHalf]}>
              <Text style={[dropdownStyles.rowLabel, dropdownStyles.pinnedLabel]}>Payment/Transfer</Text>
            </Pressable>
            {/* Split (syscd-app-rlt): opens the row's split editor. Only shown
                through onSplitPick — register rows that can host it. */}
            {onSplitPick ? (
              <Pressable
                onPressIn={() => {
                  onSplitPick();
                  close();
                }}
                {...pressNoBlur}
                style={[dropdownStyles.pinnedRow, dropdownStyles.row, styles.footerHalf]}>
                <Text style={[dropdownStyles.rowLabel, dropdownStyles.pinnedLabel]}>Split</Text>
              </Pressable>
            ) : null}
          </View>
        }
        portalMinWidth={240}>
        {rows}
      </DropdownShell>
    </View>
  );
}

const styles = StyleSheet.create({
  cell: { position: 'relative', zIndex: 30 },
  cellInner: { position: 'relative' },
  selectedLabel: { color: colors.text, fontWeight: '600' },
  footerRow: { flexDirection: 'row' },
  footerHalf: { flex: 1 },
});
