/** Where the Plan screen's popovers and the numpad-aligned row land. Pure geometry (px). */

/** Gap between the tapped row's bottom edge and the numpad panel's top edge. */
export const NUMPAD_ALIGN_GAP = 8;

/** 4rr: the header Assign dropdown hangs 6px under its button, right edges aligned (12px minimum margin). */
export function assignDropdownAnchor(
  button: { x: number; y: number; width: number; height: number },
  viewportWidth: number,
): { top: number; right: number } {
  return { top: button.y + button.height + 6, right: Math.max(12, viewportWidth - (button.x + button.width)) };
}

/** Recent Moves card: under the press point, kept 12px from the left edge and inside the window. */
export function recentCardPosition(anchor: { x: number; y: number }, windowWidth: number): { left: number; top: number } {
  return { left: Math.max(12, Math.min(anchor.x, windowWidth - 330)), top: anchor.y + 6 };
}

/** pjtv: the move/cover popover under the pressed pill, clamped into the window. */
export function pillPopPosition(
  anchor: { x: number; y: number },
  window: { width: number; height: number },
): { left: number; top: number } {
  return {
    left: Math.max(12, Math.min(anchor.x - 24, window.width - 312)),
    // YNAB flips the popover above the pill when it won't fit
    // below; ~320px of card keeps it inside the viewport either way.
    top: Math.min(anchor.y + 14, Math.max(12, window.height - 330)),
  };
}

/**
 * qitk (T3): the list offset that puts the tapped row directly above the
 * numpad panel (NUMPAD_ALIGN_GAP between them). Null = leave the list alone:
 * the panel is not laid out yet (`panelY` 0) or the row is already there
 * (under 1px off). Never scrolls above the top.
 */
export function numpadAlignOffset(row: { y: number; height: number }, panelY: number, listOffset: number): number | null {
  if (!panelY) return null; // panel not laid out yet — skip
  const delta = row.y - (panelY - NUMPAD_ALIGN_GAP - row.height);
  if (Math.abs(delta) < 1) return null;
  return Math.max(0, listOffset + delta);
}
