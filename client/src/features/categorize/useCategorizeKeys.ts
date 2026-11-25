/**
 * Web keyboard shortcuts of the One by one view. One document listener (in the
 * capture phase: RN-web's root stops keydown bubbling) maps the key through
 * `categorizeKeyAction`; keys typed into a field, or with a modifier held, are
 * never taken. Everything the keys mean lives in keys.logic.ts.
 */

import { useEffect, useRef } from 'react';

import {
  categorizeKeyAction,
  hasModifier,
  isControlTarget,
  isTypingTarget,
  type CategorizeKeyAction,
} from './keys.logic';

export function useCategorizeKeys({
  enabled,
  suggestions,
  undoAvailable,
  onAction,
}: {
  enabled: boolean;
  /** Suggestion chips on the focused row. */
  suggestions: number;
  undoAvailable: boolean;
  onAction: (action: CategorizeKeyAction) => void;
}): void {
  // The listener reads the latest values without being re-attached per render.
  const latest = useRef({ suggestions, undoAvailable, onAction });
  latest.current = { suggestions, undoAvailable, onAction };

  useEffect(() => {
    if (!enabled || process.env.EXPO_OS !== 'web' || typeof document === 'undefined') return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || hasModifier(e)) return;
      const target = e.target as HTMLElement | null;
      const action = categorizeKeyAction(e.key, {
        suggestions: latest.current.suggestions,
        undoAvailable: latest.current.undoAvailable,
        typing: isTypingTarget(target),
        onControl: isControlTarget(target),
      });
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.onAction(action);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}
