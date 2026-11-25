/**
 * The one-by-one keyboard map. The screen owns the event listener and calls
 * this pure function with the focused row's chip count and whether a text
 * field has focus; everything the keys mean lives here.
 *
 * 1/2/3 file with that chip, Enter files the top chip, S skips, / focuses the
 * category search, Z undoes the last accept. While a field is focused every
 * key belongs to the field (so "s" types an "s" in the search).
 */

export type CategorizeKeyAction =
  | { kind: 'file'; index: number }
  | { kind: 'fileTop' }
  | { kind: 'skip' }
  | { kind: 'focusSearch' }
  | { kind: 'undo' };

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
  if (ctx.typing) return null;
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
