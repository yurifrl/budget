/**
 * All Accounts toolbar — one YNAB-style row (syscd-accounts): periwinkle
 * icon+label actions (Add Transaction, File Import), a separator, Undo / Redo
 * wired to the session plan-edit history (syscd-app-ijn), a row-density View
 * menu (Modal-backed dropdown so outside taps close it: row density, Show
 * Reconciled, Running Balance, date range) and the register search input
 * pinned to the right. On phone this is the search row only — the ⋯ actions
 * moved to the screen header (`AccountsMoreMenu`, spec item 9). Reconcile
 * session actions (Finish reconciling / Reconcile anyway) live in the
 * reconcile banner, not the toolbar.
 */

import { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View, type ViewInstance } from 'react-native';

import { useAppDispatch, useAppSelector } from '@/store/hooks';

import { selectPlanEdits } from '../../state/planEdits';
import { redoPlanEdit, undoPlanEdit } from '../../state/planEditsThunks';
import {
  ChevronDownIcon,
  FileImportIcon,
  MagnifierIcon,
  PlusCircleIcon,
  RedoIcon,
  UndoIcon,
} from '../../ui/icons';
import { colors, radius } from '../../ui/theme';

export type RegisterDensity = 'compact' | 'comfortable';

const DENSITY_OPTIONS = [
  { key: 'comfortable' as const, label: 'Comfortable rows' },
  { key: 'compact' as const, label: 'Compact rows' },
];

const SYNC_TONE_COLOR = {
  ok: colors.greenPillFg,
  warn: colors.yellowPillFg,
  bad: colors.redFg,
  off: colors.muted,
} as const;

export function AccountsToolbar({
  showAdd = true,
  phone = false,
  density,
  onDensityChange,
  showReconciled,
  onShowReconciledChange,
  showRunningBalance,
  onShowRunningBalanceChange,
  showClosedTxns,
  onShowClosedTxnsChange,
  dateFrom,
  onDateFromChange,
  dateTo,
  onDateToChange,
  searchQuery,
  onSearchChange,
  onAddTransaction,
  onImport,
  sync,
}: {
  /** Hide toolbar actions; render the search row only (phone). */
  phone?: boolean;
  /** Hidden on phone, where the shell's bottom bar owns transaction adding. */
  showAdd?: boolean;
  density: RegisterDensity;
  onDensityChange: (d: RegisterDensity) => void;
  /** Reconciled rows hidden unless shown (syscd-app-lqu). */
  showReconciled: boolean;
  onShowReconciledChange: (v: boolean) => void;
  /** Register running-balance column (syscd-app-ojj), off by default. */
  showRunningBalance: boolean;
  onShowRunningBalanceChange: (v: boolean) => void;
  /** Closed-account rows hidden in All Accounts unless shown (YNAB parity). */
  showClosedTxns: boolean;
  onShowClosedTxnsChange: (v: boolean) => void;
  /** Register date range (inclusive, YYYY-MM-DD; blank = open end). */
  dateFrom: string;
  onDateFromChange: (v: string) => void;
  dateTo: string;
  onDateToChange: (v: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onAddTransaction: () => void;
  onImport: () => void;
  /** The selected account's bank-connection state; absent when unlinked. */
  sync?: {
    bank: string;
    tone: 'ok' | 'warn' | 'bad' | 'off';
    label: string;
    stamp: string | null;
  };
}) {
  const dispatch = useAppDispatch();
  const planEdits = useAppSelector((s) => selectPlanEdits(s));
  const canUndo = planEdits.past.length > 0;
  const canRedo = planEdits.future.length > 0;

  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const viewBtnRef = useRef<ViewInstance>(null);

  const openMenu = () => {
    viewBtnRef.current?.measureInWindow((x, y, _w, h) => {
      setAnchor({ x, y: y + h + 6 });
      setMenuOpen(true);
    });
  };

  // Phone ⋯ menu moved to the screen header (AccountsMoreMenu, tk-lj5l).
  const syncChip = sync ? (
    <View
      style={styles.syncChip}
      accessibilityLabel={`Bank sync status: ${sync.bank} ${sync.label}`}
    >
      <View style={[styles.syncDot, { backgroundColor: SYNC_TONE_COLOR[sync.tone] }]} />
      <Text style={styles.syncText} numberOfLines={1}>
        {sync.bank} · {sync.label}
        {sync.stamp ? ` · ${sync.stamp}` : ''}
      </Text>
    </View>
  ) : null;

  if (phone) {
    return (
      <View style={styles.toolbar}>
        {syncChip}
        <View style={[styles.searchWrap, styles.searchWrapPhone]}>
          <MagnifierIcon color={colors.faint} />
          <TextInput
            value={searchQuery}
            onChangeText={onSearchChange}
            placeholder="Search All Accounts"
            placeholderTextColor={colors.faint}
            style={styles.searchInput}
            accessibilityLabel="Search transactions"
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.toolbar}>
      {showAdd ? (
        <Pressable
          onPress={onAddTransaction}
          style={styles.action}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="Add Transaction">
          <PlusCircleIcon color={colors.indigo3} />
          <Text style={styles.actionText}>Add Transaction</Text>
        </Pressable>
      ) : null}
      <Pressable
        onPress={onImport}
        style={styles.action}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel="File Import">
        <FileImportIcon color={colors.indigo3} />
        <Text style={styles.actionText}>File Import</Text>
      </Pressable>

      <View style={styles.sep} />

      {(
        [
          {
            label: 'Undo',
            icon: <UndoIcon color={colors.indigo3} />,
            enabled: canUndo,
            press: () => void dispatch(undoPlanEdit()),
          },
          {
            label: 'Redo',
            icon: <RedoIcon color={colors.indigo3} />,
            enabled: canRedo,
            press: () => void dispatch(redoPlanEdit()),
          },
        ] as const
      ).map((b) => (
        <Pressable
          key={b.label}
          onPress={b.enabled ? b.press : undefined}
          style={[styles.action, !b.enabled && styles.actionDisabled]}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={b.label}
          accessibilityState={{ disabled: !b.enabled }}>
          {b.icon}
          <Text style={styles.actionText}>{b.label}</Text>
        </Pressable>
      ))}

      <View ref={viewBtnRef} collapsable={false}>
        <Pressable
          onPress={openMenu}
          style={styles.action}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="View options">
          <Text style={styles.actionText}>View</Text>
          <ChevronDownIcon color={colors.indigo3} />
        </Pressable>
      </View>
      <Modal transparent visible={menuOpen} animationType="none" onRequestClose={() => setMenuOpen(false)}>
        <Pressable
          style={styles.scrim}
          accessibilityLabel="Close view menu"
          onPress={() => setMenuOpen(false)}
        />
        {anchor ? (
          <View style={[styles.menu, { top: anchor.y, left: Math.max(anchor.x - 40, 8) }]}>
            {DENSITY_OPTIONS.map((opt) => (
              <Pressable
                key={opt.key}
                onPress={() => {
                  onDensityChange(opt.key);
                  setMenuOpen(false);
                }}
                style={[styles.menuItem, density === opt.key && styles.menuItemActive]}
                accessibilityRole="menuitem">
                <Text style={styles.menuItemText}>{opt.label}</Text>
                <Text style={styles.menuCheck}>{density === opt.key ? '✓' : ''}</Text>
              </Pressable>
            ))}
            <View style={styles.menuSep} />
            <Pressable
              onPress={() => {
                onShowReconciledChange(!showReconciled);
                setMenuOpen(false);
              }}
              style={styles.menuItem}
              accessibilityRole="menuitem">
              <Text style={styles.menuItemText}>Show Reconciled</Text>
              <Text style={styles.menuCheck}>{showReconciled ? '✓' : ''}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                onShowRunningBalanceChange(!showRunningBalance);
                setMenuOpen(false);
              }}
              style={styles.menuItem}
              accessibilityRole="menuitem">
              <Text style={styles.menuItemText}>Running Balance</Text>
              <Text style={styles.menuCheck}>{showRunningBalance ? '✓' : ''}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                onShowClosedTxnsChange(!showClosedTxns);
                setMenuOpen(false);
              }}
              style={styles.menuItem}
              accessibilityRole="menuitem">
              <Text style={styles.menuItemText}>Show Closed-Account Transactions</Text>
              <Text style={styles.menuCheck}>{showClosedTxns ? '✓' : ''}</Text>
            </Pressable>
            <View style={styles.menuSep} />
            <View style={styles.dateRow}>
              <Text style={styles.dateLabel}>From</Text>
              <TextInput
                value={dateFrom}
                onChangeText={onDateFromChange}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.faint}
                style={styles.dateInput}
                accessibilityLabel="Filter from date"
              />
            </View>
            <View style={styles.dateRow}>
              <Text style={styles.dateLabel}>To</Text>
              <TextInput
                value={dateTo}
                onChangeText={onDateToChange}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.faint}
                style={styles.dateInput}
                accessibilityLabel="Filter to date"
              />
            </View>
          </View>
        ) : null}
      </Modal>

      {syncChip}
      <View style={styles.searchWrap}>
        <MagnifierIcon color={colors.faint} />
        <TextInput
          value={searchQuery}
          onChangeText={onSearchChange}
          placeholder="Search All Accounts"
          placeholderTextColor={colors.faint}
          style={styles.searchInput}
          accessibilityLabel="Search transactions"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 20,
    paddingVertical: 9,
    flexWrap: 'wrap',
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  actionText: { color: colors.indigo3, fontWeight: '600', fontSize: 13 },
  actionDisabled: { opacity: 0.35 },
  sep: { width: 1, height: 18, backgroundColor: colors.border2, marginHorizontal: 6 },
  scrim: { ...StyleSheet.absoluteFill },
  menu: {
    position: 'absolute',
    minWidth: 180,
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    paddingVertical: 4,
  },
  menuSep: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  menuItemActive: { backgroundColor: colors.hover },
  menuItemText: { color: colors.text, fontSize: 13 },
  menuCheck: { color: colors.indigo2, fontSize: 13, fontWeight: '700', minWidth: 14, textAlign: 'right' },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  dateLabel: { color: colors.muted, fontSize: 13, width: 34 },
  dateInput: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    minWidth: 220,
  },
  searchInput: { color: colors.text, fontSize: 13, paddingVertical: 8, flex: 1 },
  searchWrapPhone: { flex: 1, marginLeft: 0 },
  syncChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexShrink: 1,
  },
  syncDot: { width: 8, height: 8, borderRadius: 4 },
  syncText: { color: colors.muted, fontSize: 12, flexShrink: 1 },
});
