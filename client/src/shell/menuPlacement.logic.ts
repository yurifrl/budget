/**
 * Where the settings menu sits: above its trigger (the account row pinned to
 * the bottom of the rail), growing upward, always inside the window.
 *
 * The menu is anchored by its bottom edge, so a pane of any height keeps its
 * last row next to the trigger and only the pane body's max height has to be
 * computed. All numbers are window pixels.
 */

export interface MenuPlacementInput {
  /** Trigger's top-left corner in the window (measureInWindow). */
  trigger: { x: number; y: number };
  win: { width: number; height: number };
  /** Preferred menu width; narrower windows shrink it. */
  menuWidth: number;
  /** Fixed chrome of the menu outside the scrolling body (title row + padding + border). */
  chromeHeight: number;
  /** Tallest the pane body may get on a roomy window. */
  bodyCap: number;
  /** Space between the trigger's top edge and the menu. */
  gap?: number;
  /** Minimum distance to every window edge. */
  margin?: number;
  /** Status bar / notch height the menu must stay below. */
  topInset?: number;
  /** On-screen keyboard height (native); the menu rides above it. */
  keyboardHeight?: number;
}

export interface MenuPlacement {
  left: number;
  /** Distance from the window's bottom edge to the menu's bottom edge. */
  bottom: number;
  width: number;
  /** Max height of the scrolling pane body. */
  maxBody: number;
}

/** Below this body height the menu stops respecting the trigger and covers it. */
export const MIN_MENU_BODY = 200;
/** A body never gets smaller than this, however short the window. */
const FLOOR_BODY = 96;

export function menuPlacement({
  trigger,
  win,
  menuWidth,
  chromeHeight,
  bodyCap,
  gap = 6,
  margin = 8,
  topInset = 0,
  keyboardHeight = 0,
}: MenuPlacementInput): MenuPlacement {
  const width = Math.max(0, Math.min(menuWidth, win.width - margin * 2));
  const left = Math.max(margin, Math.min(trigger.x, win.width - width - margin));

  const room = (bottom: number) => win.height - bottom - margin - topInset - chromeHeight;
  const lowest = Math.max(margin, keyboardHeight + margin);
  // Above the trigger; an unmeasured trigger (y <= 0) falls back to the bottom edge.
  const measured = Number.isFinite(trigger.y) && trigger.y > 0;
  let bottom = measured ? Math.max(lowest, win.height - trigger.y + gap) : lowest;
  // Too little room above the trigger (short window, keyboard up): cover it.
  if (room(bottom) < MIN_MENU_BODY) bottom = lowest;

  return { left, bottom, width, maxBody: Math.max(FLOOR_BODY, Math.min(bodyCap, room(bottom))) };
}
