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
}

export function categorizeKeyAction(key: string, ctx: CategorizeKeyContext): CategorizeKeyAction | null {
  if (ctx.typing) return null;
  if (key === '1' || key === '2' || key === '3') {
    const index = Number(key) - 1;
    return index < ctx.suggestions ? { kind: 'file', index } : null;
  }
  switch (key) {
    case 'Enter':
      return ctx.suggestions > 0 ? { kind: 'fileTop' } : null;
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
