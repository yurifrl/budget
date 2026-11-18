/**
 * useReconcileSession: the YNAB-parity reconcile flow for the selected
 * account (syscd-app-mbi): header entry → confirm popover → live-difference
 * banner → adjustment. Owns the session state, the popover anchor and the
 * reconcile mutation; the screen renders the banner and popover from it.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ViewInstance } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import { useReconcileAccountMutation } from '@/budget/data/api';
import { workingBalance } from '@/domain/engine';
import type { Account } from '@/domain/types';
import { desktopReconcileAnchor, phoneReconcileAnchor, reconcileDifference } from './reconcile.logic';

export function useReconcileSession({
  budgetId,
  selectedAccount,
  selectedAccountId,
  isPhone,
  screenRef,
  onToast,
}: {
  budgetId: string | null | undefined;
  selectedAccount: Account | undefined;
  selectedAccountId: string | null;
  isPhone: boolean;
  /** The screen root: the popover is absolutely positioned inside it. */
  screenRef: RefObject<ViewInstance | null>;
  onToast: (text: string) => void;
}) {
  const [reconciling, setReconciling] = useState(false);
  const [statedBalance, setStatedBalance] = useState(0);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconcileAccount, reconcileState] = useReconcileAccountMutation();
  // Reconcile session (syscd-app-mbi): the confirm popover anchor in
  // screen-root space, then a live-difference banner. "No" on the question
  // closes the popover and does nothing — no statement-entry path.
  const [reconcileAnchor, setReconcileAnchor] = useState<{ x: number; y: number } | null>(null);
  // Reconcile button wrapper — the confirm popover anchors under it.
  const reconcileBtnRef = useRef<ViewInstance>(null);
  // tk-lj5l: phone popover anchor — the header row itself, since the phone
  // Reconcile entry lives in the ⋯ menu rather than a measurable button.
  const topbarRef = useRef<ViewInstance>(null);

  // Switching accounts mid-session would strand the banner on the wrong
  // account — close the session and popover too.
  useEffect(() => {
    setReconciling(false);
    setReconcileAnchor(null);
  }, [selectedAccountId]);

  const startReconcile = (anchor: { x: number; y: number }) => {
    if (!selectedAccount) return;
    setStatedBalance(workingBalance(selectedAccount));
    setReconcileAnchor(anchor);
  };

  // Popover anchor derived from the header button's own geometry — no press
  // event needed, so it works identically at desktop and phone widths. The
  // button is right-aligned, so clamp x to keep the popover on screen.
  const openReconcilePopover = () => {
    // tk-lj5l: on phone the standalone Reconcile button is gone (the action
    // lives in the header ⋯ menu), so there is no button geometry to anchor
    // to — right-align the popover under the header instead.
    if (isPhone) {
      topbarRef.current?.measureInWindow((_tx, ty, _tw, th) => {
        screenRef.current?.measureInWindow((_sx, sy, sw) => {
          startReconcile(phoneReconcileAnchor({ y: ty, h: th }, { y: sy, w: sw }));
        });
      });
      return;
    }
    reconcileBtnRef.current?.measureInWindow((bx, by, bw, bh) => {
      screenRef.current?.measureInWindow((sx, sy, sw) => {
        startReconcile(desktopReconcileAnchor({ x: bx, y: by, w: bw, h: bh }, { x: sx, y: sy, w: sw }));
      });
    });
  };

  // Question answers (syscd-app-mbi, YNAB semantics). "No" opens the
  // statement-entry session — the user enters the bank balance and YNAB
  // computes the difference. "Yes" means the on-screen balance already
  // matches the bank, so everything reconciles instantly: no session, no
  // adjustment, nothing for the user to do.
  const confirmReconcileQuestion = () => {
    setReconcileAnchor(null);
    setReconciling(true);
  };

  const reconcileAllNow = async () => {
    if (!budgetId || !selectedAccount || reconcileState.isLoading) return;
    setReconcileAnchor(null);
    setReconcileError(null);
    try {
      await reconcileAccount({
        budgetId,
        accountId: selectedAccount.id,
        statedBalanceCents: workingBalance(selectedAccount),
        reconcileAll: true,
      }).unwrap();
      onToast('Account reconciled');
    } catch (err) {
      // Auto-reconcile failed (network/server): drop into the manual session
      // so the user can finish it by hand instead of a dead-end error.
      setReconciling(true);
      setStatedBalance(workingBalance(selectedAccount));
      setReconcileError(apiErrorMessage(err, 'failed to reconcile account'));
    }
  };

  const confirmReconcile = async () => {
    if (!budgetId || !selectedAccount || reconcileState.isLoading) return;
    setReconcileError(null);
    try {
      await reconcileAccount({
        budgetId,
        accountId: selectedAccount.id,
        statedBalanceCents: statedBalance,
      }).unwrap();
      setReconciling(false);
      // syscd-app-qfr: success toast; reconciled rows vanish because the
      // showReconciled view option defaults to false.
      onToast('Account reconciled');
    } catch (err) {
      setReconcileError(apiErrorMessage(err, 'failed to reconcile account'));
    }
  };

  return {
    reconciling,
    statedBalance,
    setStatedBalance,
    reconcileError,
    reconcileAnchor,
    reconcileBtnRef,
    topbarRef,
    reconcileDiff: reconcileDifference(reconciling, selectedAccount, statedBalance),
    openReconcilePopover,
    confirmReconcileQuestion,
    reconcileAllNow,
    confirmReconcile,
    cancelReconcile: () => setReconciling(false),
    closeReconcilePopover: () => setReconcileAnchor(null),
  };
}
