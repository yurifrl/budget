/**
 * Pure pieces of the reconcile flow on the Accounts screen: where the confirm
 * popover anchors (screen-root space) and the session's live difference.
 */

import { workingBalance } from '@/domain/engine';
import type { Account, Cents } from '@/domain/types';
import { t } from './i18n';

/** Popover width budget used to keep it on screen. */
const POPOVER_W = 268;

/**
 * Desktop/tablet: anchor derived from the header button's own geometry (window
 * coords) and the screen root's. The button is right-aligned, so x clamps to
 * keep the popover on screen.
 */
export function desktopReconcileAnchor(
  btn: { x: number; y: number; w: number; h: number },
  screen: { x: number; y: number; w: number },
): { x: number; y: number } {
  const rawX = btn.x - screen.x + btn.w - 16;
  return {
    x: screen.w ? Math.max(0, Math.min(rawX, screen.w - POPOVER_W)) : rawX,
    y: btn.y - screen.y + btn.h + 6,
  };
}

/**
 * tk-lj5l: no standalone button on phone, so anchor the popover under the
 * header row itself (right-aligned, same clamp as desktop).
 */
export function phoneReconcileAnchor(
  topbar: { y: number; h: number },
  screen: { y: number; w: number },
): { x: number; y: number } {
  const belowTopbar = topbar.y - screen.y + topbar.h + 6;
  return {
    x: screen.w ? Math.max(0, screen.w - POPOVER_W) : 0,
    y: topbar.h > 0 ? belowTopbar : 96,
  };
}

/**
 * Live difference for the session banner, in cents. 0 means a plain lock-in.
 * YNAB semantics: the difference is the stated balance vs the WORKING
 * balance (cleared + uncleared); reconciling locks every row. Finishing at 0
 * books no adjustment; the server (PATCH /accounts/:id/reconcile) compares
 * the same values.
 */
export function reconcileDifference(
  reconciling: boolean,
  account: Pick<Account, 'clearedBalance' | 'unclearedBalance'> | undefined,
  statedBalance: Cents,
): Cents {
  return reconciling && account ? statedBalance - workingBalance(account as Account) : 0;
}

/** Toast after the connect flow lands here with ?linked=N. */
export function linkedToastText(count: number): string {
  return t('reconcile.linkedToast', { count });
}
