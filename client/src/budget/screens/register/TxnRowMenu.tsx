/**
 * TxnRowMenu — the register row's context menu (syscd-app-42f), replicating
 * YNAB's row menu (checked live against app.ynab.com): Approve / Reject,
 * Mark as Cleared / Mark as Uncleared, Match / Unmatch, Duplicate, Make
 * Repeating, Flag, Memo…, Categorize, Move to Account, Export 1 Transaction,
 * Delete — each row with a leading icon and YNAB's shortcut chips (A ·
 * shift R · C · M · shift U · shift D · shift T · delete), sections split by
 * hairline dividers. Every action is wired to a real mutation. Presentation
 * mirrors PlanScreen's RowMenu: full-screen backdrop + anchored card,
 * Escape/backdrop dismiss, submenus swap the card contents in place behind a
 * back header that returns to the main list.
 */

import { type ComponentProps, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import type { Budget, Transaction } from '../../domain/types';
import { displayFlagLabel } from '../../domain/flagLabels';
import { useFlagLabels } from '../../model/useDisplayPrefs';
import { REPEAT_FREQS, REPEAT_LABELS } from './InlineAddRow';
import { FLAG_COLORS, colors, radius } from '../../ui/theme';
import { centsFmt, shortDate, useTxnRowMenuActions } from './txnRowMenuShared';

type MenuPanel = 'main' | 'match' | 'repeat' | 'move' | 'flag' | 'category';

/** One row of the main menu (YNAB's modal-list item). */
type MainItem = {
  key: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  /** YNAB shortcut chips, rendered right-aligned ("shift" + "R" = shift R). */
  kbd?: string[];
  danger?: boolean;
  disabled?: boolean;
  /** Item opens a submenu (▸ hint). */
  submenu?: boolean;
  onPress?: () => void;
};

export function TxnRowMenu({
  anchor,
  txn,
  budget,
  budgetId,
  onEditMemo,
  onClose,
}: {
  /** Pointer position (page coords) where the row opened the menu. */
  anchor: { x: number; y: number };
  txn: Transaction;
  budget: Budget;
  budgetId: string;
  /** Memo… opens the row editor focused on this transaction. */
  onEditMemo: (txn: Transaction) => void;
  onClose: () => void;
}) {
  const [panel, setPanel] = useState<MenuPanel>('main');
  // Measured card size — lets the anchored position clamp against the window
  // so bottom items (e.g. Delete) never fall below the viewport.
  const [cardSize, setCardSize] = useState<{ w: number; h: number } | null>(null);
  const { width: winW, height: winH } = useWindowDimensions();
  const flagLabels = useFlagLabels();
  const {
    approve,
    reject,
    setClear,
    setFlag,
    categorize,
    makeRepeat,
    moveTo,
    duplicate,
    doDelete,
    match,
    unmatch,
    exportCsv,
    busy,
    candidates,
    matched,
    moveTargets,
  } = useTxnRowMenuActions({ txn, budget, budgetId, onClose });

  // Escape (and backdrop press) close the menu — capture so the register's
  // own key handling never eats it first.
  useEffect(() => {
    if (process.env.EXPO_OS !== 'web') return undefined;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const subLabel =
    panel === 'match'
      ? 'Match'
      : panel === 'repeat'
        ? 'Make Repeating'
        : panel === 'move'
          ? 'Move to Account'
          : panel === 'flag'
            ? 'Flag'
            : panel === 'category'
              ? 'Categorize'
              : null;

  // The main menu in YNAB's exact order, grouped by its divider sections.
  // Disabled states mirror YNAB: approve/reject only where applicable,
  // cleared flips only when the target state differs, unmatch needs a match,
  // reconciled rows can't be (un)cleared.
  const mainSections: MainItem[][] = [
    [
      { key: 'approve', icon: 'checkmark', label: 'Approve', kbd: ['A'], disabled: txn.approved, onPress: approve },
      {
        key: 'reject',
        icon: 'close',
        label: 'Reject',
        kbd: ['shift', 'R'],
        disabled: txn.approved || txn.importId == null,
        onPress: reject,
      },
    ],
    [
      {
        key: 'clear',
        icon: 'checkmark-circle-outline',
        label: 'Mark as Cleared',
        kbd: ['C'],
        disabled: txn.cleared !== 'uncleared',
        onPress: () => setClear('cleared'),
      },
      {
        key: 'unclear',
        icon: 'ellipse-outline',
        label: 'Mark as Uncleared',
        kbd: ['C'],
        disabled: txn.cleared !== 'cleared',
        onPress: () => setClear('uncleared'),
      },
    ],
    [
      {
        key: 'match',
        icon: 'git-compare',
        label: 'Match',
        kbd: ['M'],
        submenu: true,
        disabled: candidates.length === 0 || busy,
        onPress: () => setPanel('match'),
      },
      {
        key: 'unmatch',
        icon: 'unlink',
        label: 'Unmatch',
        kbd: ['shift', 'U'],
        disabled: !txn.matchedTransactionId || busy,
        onPress: unmatch,
      },
    ],
    [
      { key: 'duplicate', icon: 'copy-outline', label: 'Duplicate', kbd: ['shift', 'D'], disabled: busy, onPress: duplicate },
      {
        key: 'repeat',
        icon: 'repeat',
        label: 'Make Repeating',
        kbd: ['shift', 'T'],
        submenu: true,
        disabled: txn.repeatRuleId != null || txn.upcoming || busy,
        onPress: () => setPanel('repeat'),
      },
      { key: 'flag', icon: 'flag', label: 'Flag', submenu: true, onPress: () => setPanel('flag') },
      { key: 'memo', icon: 'create-outline', label: 'Memo…', onPress: () => { onEditMemo(txn); onClose(); } },
      { key: 'categorize', icon: 'pricetag-outline', label: 'Categorize', submenu: true, onPress: () => setPanel('category') },
    ],
    [
      {
        key: 'move',
        icon: 'swap-horizontal',
        label: 'Move to Account',
        submenu: true,
        disabled: moveTargets.length === 0 || busy,
        onPress: () => setPanel('move'),
      },
      { key: 'export', icon: 'download-outline', label: 'Export 1 Transaction', onPress: exportCsv },
    ],
    [
      { key: 'delete', icon: 'trash-outline', label: 'Delete', kbd: ['delete'], danger: true, onPress: doDelete },
    ],
  ];

  // Prefer below-right of the anchor (like PlanScreen's RowMenu), then clamp
  // both axes so the whole card stays on screen even for bottom rows. The
  // vertical margin clears the fixed bottom chrome (49px tab bar + floating
  // "＋ Transaction" button) that overlays the register.
  const cardLeft = Math.max(12, Math.min(anchor.x - 190, winW - (cardSize?.w ?? 240) - 12));
  const cardTop = Math.min(anchor.y + 6, Math.max(12, winH - (cardSize?.h ?? 320) - 60));

  return (
    <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Fechar menu da transação">
      {/* Swallow clicks so item presses don't bubble to the backdrop. */}
      <Pressable
        onPress={(e) => e.stopPropagation()}
        onLayout={(e) =>
          setCardSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
        }
        style={[styles.card, { left: cardLeft, top: cardTop }]}>
        {subLabel ? (
          <Pressable
            style={styles.titleRow}
            onPress={() => setPanel('main')}
            accessibilityLabel="Back to menu">
            <Ionicons name="chevron-back" size={13} color={colors.muted} />
            <Text style={styles.title}>{subLabel}</Text>
          </Pressable>
        ) : null}
        {panel === 'main' ? (
          <View>
            {mainSections.map((sec, si) => (
              <View key={si}>
                {si > 0 ? <View style={styles.divider} /> : null}
                {sec.map((it) => (
                  <Pressable
                    key={it.key}
                    style={styles.item}
                    disabled={it.disabled}
                    onPress={it.onPress}
                    accessibilityLabel={it.label.replace('…', '')}>
                    <View style={styles.itemIcon}>
                      <Ionicons
                        name={it.icon}
                        size={15}
                        color={it.danger ? colors.redFg : it.disabled ? colors.faint : colors.muted}
                      />
                    </View>
                    <Text
                      style={[
                        styles.itemText,
                        it.danger && styles.itemDanger,
                        it.disabled && styles.itemDisabled,
                      ]}>
                      {it.label}
                    </Text>
                    {it.kbd ? (
                      <View style={styles.kbdRow}>
                        {it.kbd.map((k) => (
                          <Text key={k} style={styles.kbd}>
                            {k}
                          </Text>
                        ))}
                      </View>
                    ) : null}
                    {it.submenu ? <Text style={styles.itemHint}>▸</Text> : null}
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
        ) : null}
        {panel === 'match' ? (
          <View>
            {candidates.length === 0 ? (
              <Text style={styles.empty}>No matching transactions</Text>
            ) : (
              candidates.map((t) => (
                <Pressable
                  key={t.id}
                  style={styles.item}
                  onPress={() => match(t)}
                  accessibilityLabel={`Match with ${t.payee}`}>
                  <Text style={styles.itemText} numberOfLines={1}>
                    {t.payee || '(no payee)'}
                  </Text>
                  <Text style={styles.itemHint}>
                    {shortDate(t.date)} · {centsFmt.format((t.inflow - t.outflow) / 100)}
                  </Text>
                </Pressable>
              ))
            )}
            {matched ? (
              <Text style={styles.empty}>Matched with {matched.payee || '(no payee)'}</Text>
            ) : null}
          </View>
        ) : null}
        {panel === 'repeat' ? (
          <View>
            {REPEAT_FREQS.map((f) => (
              <Pressable key={f} style={styles.item} onPress={() => makeRepeat(f)}>
                <Text style={styles.itemText}>{REPEAT_LABELS[f]}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {panel === 'flag' ? (
          <View>
            <Pressable
              style={styles.item}
              onPress={() => setFlag(null)}
              accessibilityLabel="No flag">
              <View style={styles.itemIcon}>
                <Ionicons name="flag" size={15} color={colors.faint} />
              </View>
              <Text style={styles.itemText}>No flag</Text>
            </Pressable>
            {FLAG_COLORS.map((f) => (
              <Pressable
                key={f.key}
                style={styles.item}
                onPress={() => setFlag(f.key)}
                accessibilityLabel={displayFlagLabel(flagLabels, f.key)}>
                <View style={styles.itemIcon}>
                  <Ionicons name="flag" size={15} color={f.hex} />
                </View>
                <Text style={styles.itemText}>{displayFlagLabel(flagLabels, f.key)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {panel === 'category' ? (
          <ScrollView style={styles.listScroll} contentContainerStyle={{ paddingBottom: 4 }}>
            <Pressable style={styles.item} onPress={() => categorize(null)}>
              <View style={styles.itemIcon}>
                <Ionicons name="pricetag-outline" size={15} color={colors.faint} />
              </View>
              <Text style={styles.itemText}>Ready to Assign</Text>
            </Pressable>
            {budget.groups.map((g) => {
              const groupCats = budget.categories.filter((c) => c.groupId === g.id && !c.hidden);
              if (groupCats.length === 0) return null;
              return (
                <View key={g.id}>
                  <Text style={styles.groupLabel}>{g.name}</Text>
                  {groupCats.map((c) => (
                    <Pressable key={c.id} style={styles.item} onPress={() => categorize(c.id)}>
                      <View style={styles.itemIcon}>
                        <Ionicons name="pricetag-outline" size={15} color={colors.muted} />
                      </View>
                      <Text style={styles.itemText} numberOfLines={1}>
                        {c.name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              );
            })}
          </ScrollView>
        ) : null}
        {panel === 'move' ? (
          <View>
            {moveTargets.map((a) => (
              <Pressable
                key={a.id}
                style={styles.item}
                onPress={() => moveTo(a.id)}
                accessibilityLabel={`Move to ${a.name}`}>
                <Text style={styles.itemText} numberOfLines={1}>
                  {a.name}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40 },
  card: {
    position: 'absolute',
    minWidth: 250,
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 9,
    paddingTop: 6,
    paddingBottom: 2,
  },
  title: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 3 },
  item: { paddingVertical: 7, paddingHorizontal: 14, flexDirection: 'row', gap: 8, alignItems: 'center' },
  itemIcon: { width: 22, alignItems: 'center' },
  itemText: { color: colors.text, fontSize: 13, flexShrink: 1 },
  itemHint: { color: colors.muted, fontSize: 12 },
  kbdRow: { marginLeft: 'auto', flexDirection: 'row', gap: 3, alignItems: 'center' },
  kbd: {
    minWidth: 18,
    paddingVertical: 1,
    paddingHorizontal: 4,
    textAlign: 'center',
    color: colors.muted,
    fontSize: 10,
    fontWeight: '600',
    backgroundColor: colors.card2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  listScroll: { maxHeight: 320, flexGrow: 0 },
  groupLabel: {
    color: colors.faint,
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 2,
  },
  itemDanger: { color: colors.redFg },
  itemDisabled: { color: colors.faint },
  empty: { color: colors.muted, fontSize: 12, paddingHorizontal: 14, paddingVertical: 8 },
});
