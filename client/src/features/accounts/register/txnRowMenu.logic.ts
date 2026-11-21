/**
 * Pure view-model for TxnRowMenu: the main menu's items and their enabled
 * states, submenu titles, the anchored card position and the Categorize list.
 */

import type { ComponentProps } from 'react';

import { tCommon } from '@shared/i18n/common';

import type { Ionicons } from '@expo/vector-icons';

import type { Budget, Transaction } from '@/domain/types';

import { t } from './i18n';

export type MenuPanel = 'main' | 'match' | 'repeat' | 'move' | 'flag' | 'category';

export type MainItemKey =
  | 'approve'
  | 'reject'
  | 'clear'
  | 'unclear'
  | 'match'
  | 'unmatch'
  | 'duplicate'
  | 'repeat'
  | 'flag'
  | 'memo'
  | 'categorize'
  | 'move'
  | 'export'
  | 'delete';

/** One row of the main menu (YNAB's modal-list item). */
export interface MainItem {
  key: MainItemKey;
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  /** YNAB shortcut chips, rendered right-aligned ("shift" + "R" = shift R). */
  kbd?: string[];
  danger?: boolean;
  disabled?: boolean;
  /** Item opens a submenu (▸ hint). */
  submenu?: boolean;
}

/** Back-header title of a submenu; null on the main list. */
export function menuSubLabel(panel: MenuPanel): string | null {
  return panel === 'match'
    ? t('menu.match')
    : panel === 'repeat'
      ? t('menu.makeRepeating')
      : panel === 'move'
        ? t('menu.moveToAccount')
        : panel === 'flag'
          ? t('menu.flag')
          : panel === 'category'
            ? t('menu.categorize')
            : null;
}

/**
 * The main menu in YNAB's exact order, grouped by its divider sections.
 * Disabled states mirror YNAB: approve/reject only where applicable, cleared
 * flips only when the target state differs, unmatch needs a match, reconciled
 * rows can't be (un)cleared.
 */
export function mainMenuSections(
  txn: Pick<Transaction, 'approved' | 'importId' | 'cleared' | 'matchedTransactionId' | 'repeatRuleId' | 'upcoming'>,
  ctx: {
    /** Rows this one could be matched with. */
    candidateCount: number;
    /** Accounts it could move to. */
    moveTargetCount: number;
    /** A delete or make-repeating request is in flight. */
    busy: boolean;
  },
): MainItem[][] {
  const { busy } = ctx;
  return [
    [
      { key: 'approve', icon: 'checkmark', label: t('menu.approve'), kbd: ['A'], disabled: txn.approved },
      {
        key: 'reject',
        icon: 'close',
        label: t('menu.reject'),
        kbd: ['shift', 'R'],
        disabled: txn.approved || txn.importId == null,
      },
    ],
    [
      {
        key: 'clear',
        icon: 'checkmark-circle-outline',
        label: t('menu.markCleared'),
        kbd: ['C'],
        disabled: txn.cleared !== 'uncleared',
      },
      {
        key: 'unclear',
        icon: 'ellipse-outline',
        label: t('menu.markUncleared'),
        kbd: ['C'],
        disabled: txn.cleared !== 'cleared',
      },
    ],
    [
      {
        key: 'match',
        icon: 'git-compare',
        label: t('menu.match'),
        kbd: ['M'],
        submenu: true,
        disabled: ctx.candidateCount === 0 || busy,
      },
      {
        key: 'unmatch',
        icon: 'unlink',
        label: t('menu.unmatch'),
        kbd: ['shift', 'U'],
        disabled: !txn.matchedTransactionId || busy,
      },
    ],
    [
      { key: 'duplicate', icon: 'copy-outline', label: t('menu.duplicate'), kbd: ['shift', 'D'], disabled: busy },
      {
        key: 'repeat',
        icon: 'repeat',
        label: t('menu.makeRepeating'),
        kbd: ['shift', 'T'],
        submenu: true,
        disabled: txn.repeatRuleId != null || txn.upcoming || busy,
      },
      { key: 'flag', icon: 'flag', label: t('menu.flag'), submenu: true },
      { key: 'memo', icon: 'create-outline', label: t('menu.memo') },
      { key: 'categorize', icon: 'pricetag-outline', label: t('menu.categorize'), submenu: true },
    ],
    [
      {
        key: 'move',
        icon: 'swap-horizontal',
        label: t('menu.moveToAccount'),
        submenu: true,
        disabled: ctx.moveTargetCount === 0 || busy,
      },
      { key: 'export', icon: 'download-outline', label: t('menu.export') },
    ],
    [{ key: 'delete', icon: 'trash-outline', label: tCommon('delete'), kbd: ['delete'], danger: true }],
  ];
}

/**
 * Prefer below-right of the anchor (like PlanScreen's RowMenu), then clamp
 * both axes so the whole card stays on screen even for bottom rows. The
 * vertical margin clears the fixed bottom chrome (49px tab bar + floating
 * "＋ Transaction" button) that overlays the register.
 */
export function menuCardPosition(
  anchor: { x: number; y: number },
  win: { w: number; h: number },
  /** Measured card size; null before the first layout. */
  cardSize: { w: number; h: number } | null,
): { left: number; top: number } {
  return {
    left: Math.max(12, Math.min(anchor.x - 190, win.w - (cardSize?.w ?? 240) - 12)),
    top: Math.min(anchor.y + 6, Math.max(12, win.h - (cardSize?.h ?? 320) - 60)),
  };
}

/** Categorize submenu: each group's visible categories; groups with none are skipped. */
export function menuCategoryGroups(
  budget: Pick<Budget, 'groups' | 'categories'>,
): { id: string; name: string; categories: { id: string; name: string }[] }[] {
  return budget.groups
    .map((g) => ({
      id: g.id,
      name: g.name,
      categories: budget.categories
        .filter((c) => c.groupId === g.id && !c.hidden)
        .map((c) => ({ id: c.id, name: c.name })),
    }))
    .filter((g) => g.categories.length > 0);
}
