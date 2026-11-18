/** Which of the Plan screen's popovers, sheets and inline editors are open. */
import { useState } from 'react';
import { Platform } from 'react-native';

import type { MoveMoneyRequest } from './MoveMoneySheet';

export function usePlanOverlays() {
  /** Desktop/tablet: the category whose ASSIGNED cell is an inline editor. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [moveReq, setMoveReq] = useState<MoveMoneyRequest | null>(null);
  // Phone: tapping a category row opens the full-screen YNAB-style detail page
  // instead of the inspector slide-over (selectedId stays for desktop/tablet).
  const [mobileDetailId, setMobileDetailId] = useState<string | null>(null);
  // pjtv: web pills open the move/cover form in a YNAB-style popover anchored
  // under the pill (screen-root coords from anchorAt) instead of the centered
  // modal. Native keeps the sheet.
  const [pillPop, setPillPop] = useState<{ req: MoveMoneyRequest; x: number; y: number } | null>(null);
  const [autoAssignOpen, setAutoAssignOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false); // 4rr: header Assign dropdown
  const [assignPos, setAssignPos] = useState<{ top: number; right: number } | null>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState<{ x: number; y: number } | null>(null);

  return {
    editingId,
    setEditingId,
    moveReq,
    setMoveReq,
    mobileDetailId,
    setMobileDetailId,
    pillPop,
    setPillPop,
    autoAssignOpen,
    setAutoAssignOpen,
    assignOpen,
    setAssignOpen,
    assignPos,
    setAssignPos,
    viewsOpen,
    setViewsOpen,
    recentOpen,
    setRecentOpen,
    /** Move / cover / un-assign form: anchored popover on web (screen-root x, y), the sheet on native. */
    openMoveAt: (req: MoveMoneyRequest, x: number, y: number) => {
      if (Platform.OS === 'web') setPillPop({ req, x, y });
      else setMoveReq(req);
    },
  };
}

export type PlanOverlaysState = ReturnType<typeof usePlanOverlays>;
