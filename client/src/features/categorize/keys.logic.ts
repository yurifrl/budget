/**
 * The one-by-one keyboard map. The screen owns the event listener and calls
 * this pure function with the focused row's chip count and whether a text
 * field has focus; everything the keys mean lives here.
 *
 * 1/2/3 file with that chip, Enter files the top chip, S leaves the row
 * uncategorized (pending for 10 s, so it can be undone), / focuses the category
 * search, Z undoes the last action. Nothing else is a shortcut: other letters do
 * nothing, so typing a category name never skips or files anything; only "/"
 * opens the search. While a field is focused every key belongs to the field (S,
 * Z and the digits type), except Escape, which leaves the field.
 */

export type CategorizeKeyAction =
  | { kind: 'file'; index: number }
  | { kind: 'fileTop' }
  | { kind: 'skip' }
  | { kind: 'focusSearch' }
  | { kind: 'undo' }
  /** Escape in a field: leave it and return to the shortcuts. */
  | { kind: 'leaveField' };

export interface CategorizeKeyContext {
  /** Suggestion chips on the focused row (0..3). */
  suggestions: number;
  /** A text input has focus. */
  typing: boolean;
  /** The undo toast is up (something was accepted). */
  undoAvailable: boolean;
  /** A button or link has focus: Enter belongs to it, not to "file the top one". */
  onControl?: boolean;
}

export function categorizeKeyAction(key: string, ctx: CategorizeKeyContext): CategorizeKeyAction | null {
  if (ctx.typing) return key === 'Escape' ? { kind: 'leaveField' } : null;
  if (key === '1' || key === '2' || key === '3') {
    const index = Number(key) - 1;
    return index < ctx.suggestions ? { kind: 'file', index } : null;
  }
  switch (key) {
    case 'Enter':
      return ctx.suggestions > 0 && !ctx.onControl ? { kind: 'fileTop' } : null;
    case 's':
    case 'S':
      return { kind: 'skip' };
    case '/':
      return { kind: 'focusSearch' };
    case 'z':
    case 'Z':
      return ctx.undoAvailable ? { kind: 'undo' } : null;
    default:
      return null;
  }
}

/** The slice of a DOM element the key handler needs. */
export interface KeyTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

/** A text field (or select) has focus: keys are typing, not shortcuts. */
export function isTypingTarget(target: KeyTargetLike | null | undefined): boolean {
  if (!target) return false;
  const tag = target.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

/** A button or link has focus (react-native-web renders Pressable as role="button"). */
export function isControlTarget(target: KeyTargetLike | null | undefined): boolean {
  if (!target) return false;
  const tag = target.tagName?.toUpperCase();
  const role = target.getAttribute?.('role');
  return tag === 'BUTTON' || tag === 'A' || role === 'button' || role === 'tab' || role === 'link';
}

/** Shortcuts never fire with a modifier held (Cmd+S, Ctrl+Z belong to the browser). */
export function hasModifier(e: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): boolean {
  return Boolean(e.metaKey || e.ctrlKey || e.altKey);
}

/** The CSS selector of what RN-web renders a Pressable button as. */
export const CONTROL_SELECTOR = 'button, a, [role="button"], [role="tab"]';

/**
 * The control to take focus off after a MOUSE or touch press. A pointer press
 * leaves focus on the pressed button, and Enter would then press it again (the
 * legend says Enter confirms the focused row), so every button on the page
 * lets go of focus once clicked. A keyboard activation (detail 0) keeps it, so
 * Tab navigation still works.
 */
export function controlToBlur<T>(
  target: { closest?: (selector: string) => T | null } | null | undefined,
  clickDetail: number,
): T | null {
  if (clickDetail <= 0 || !target?.closest) return null;
  return target.closest(CONTROL_SELECTOR);
}
