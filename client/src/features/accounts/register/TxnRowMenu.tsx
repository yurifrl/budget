/**
 * TxnRowMenu — the register row's context menu (syscd-app-42f), replicating
 * YNAB's row menu (checked live against app.ynab.com): Approve / Reject,
 * Mark as Cleared / Mark as Uncleared, Match / Unmatch, Duplicate, Make
 * Repeating, Flag, Memo…, Categorize, Move to Account, Export 1 Transaction,
 * Details (ours: the transaction's own page), Delete — each row with a leading icon and YNAB's shortcut chips (A ·
 * shift R · C · M · shift U · shift D · shift T · delete), sections split by
 * hairline dividers. Every action is wired to a real mutation. Presentation
 * mirrors PlanScreen's RowMenu: full-screen backdrop + anchored card,
 * Escape/backdrop dismiss, submenus swap the card contents in place behind a
 * back header that returns to the main list.
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import type { Budget, Transaction } from '@/domain/types';
import { useFlagLabels } from '@/state/useDisplayPrefs';
import { colors, radius } from '@/ui/theme';
import { mainMenuSections, menuCardPosition, menuSubLabel, type MainItemKey, type MenuPanel } from './txnRowMenu.logic';
import { CategoryPanel, FlagPanel, MainPanel, MatchPanel, MovePanel, RepeatPanel } from './TxnRowMenuPanels';
import { t } from './i18n';
import { useTxnRowMenuActions } from './txnRowMenuShared';

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
    openDetails,
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

  const subLabel = menuSubLabel(panel);

  const mainSections = mainMenuSections(txn, {
    candidateCount: candidates.length,
    moveTargetCount: moveTargets.length,
    busy,
  });
  const mainActions: Record<MainItemKey, () => void> = {
    approve,
    reject,
    clear: () => setClear('cleared'),
    unclear: () => setClear('uncleared'),
    match: () => setPanel('match'),
    unmatch,
    duplicate,
    repeat: () => setPanel('repeat'),
    flag: () => setPanel('flag'),
    memo: () => {
      onEditMemo(txn);
      onClose();
    },
    categorize: () => setPanel('category'),
    move: () => setPanel('move'),
    export: exportCsv,
    details: openDetails,
    delete: doDelete,
  };

  const { left: cardLeft, top: cardTop } = menuCardPosition({ x: anchor.x, y: anchor.y }, { w: winW, h: winH }, cardSize);

  return (
    <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t('menu.closeLabel')}>
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
            accessibilityLabel={t('menu.backLabel')}>
            <Ionicons name="chevron-back" size={13} color={colors.muted} />
            <Text style={styles.title}>{subLabel}</Text>
          </Pressable>
        ) : null}
        {panel === 'main' ? <MainPanel sections={mainSections} onItem={(key) => mainActions[key]()} /> : null}
        {panel === 'match' ? <MatchPanel candidates={candidates} matched={matched} onMatch={match} /> : null}
        {panel === 'repeat' ? <RepeatPanel onPick={makeRepeat} /> : null}
        {panel === 'flag' ? <FlagPanel flagLabels={flagLabels} onPick={setFlag} /> : null}
        {panel === 'category' ? <CategoryPanel budget={budget} onPick={categorize} /> : null}
        {panel === 'move' ? <MovePanel targets={moveTargets} onPick={moveTo} /> : null}
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
});
