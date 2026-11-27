/**
 * Web keyboard shortcuts of the Categorize page (all of them in One by one, Z in Bundles). One document listener (in the
 * capture phase: RN-web's root stops keydown bubbling) maps the key through
 * `categorizeKeyAction`; keys typed into a field, or with a modifier held, are
 * never taken. Everything the keys mean lives in keys.logic.ts.
 */

import { useEffect, useRef, useState } from 'react';

import {
  categorizeKeyAction,
  controlToBlur,
  hasModifier,
  isControlTarget,
  isTypingTarget,
  mayKeyAct,
  OVERLAY_SELECTOR,
  type CategorizeKeyAction,
  type KeyScope,
} from './keys.logic';

/** Where a key was pressed, read from the DOM: the input of `mayKeyAct`. */
function targetFacts(target: HTMLElement | null, root: HTMLElement | null) {
  const onBody = target === null || target === document.body || target === document.documentElement;
  const inPage = target !== null && root !== null && root.contains(target);
  // Any open overlay counts, wherever focus is: a menu opened from the shell
  // keeps focus inside itself, or on the body behind it.
  const overlayOpen = document.querySelector(OVERLAY_SELECTOR) !== null;
  return { onBody, inPage, overlayOpen };
}

export function useCategorizeKeys({
  enabled,
  scope = 'row',
  rootRef,
  suggestions,
  transfer = false,
  undoAvailable,
  onAction,
}: {
  enabled: boolean;
  /** 'undoOnly' in the Bundles view: only Z acts there. */
  scope?: KeyScope;
  /** The Categorize page's root view: keys pressed outside it (the shell) are not for the page. */
  rootRef: { current: unknown };
  /** Suggestion chips on the focused row. */
  suggestions: number;
  /** The focused line is a Jev transfer answer: N says it is not a transfer. */
  transfer?: boolean;
  undoAvailable: boolean;
  onAction: (action: CategorizeKeyAction) => void;
}): void {
  // The listener reads the latest values without being re-attached per render.
  const latest = useRef({ suggestions, transfer, undoAvailable, onAction, scope });
  latest.current = { suggestions, transfer, undoAvailable, onAction, scope };

  useEffect(() => {
    if (!enabled || process.env.EXPO_OS !== 'web' || typeof document === 'undefined') return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || hasModifier(e)) return;
      const target = e.target as HTMLElement | null;
      if (!mayKeyAct(targetFacts(target, rootRef.current as HTMLElement | null))) return;
      const action = categorizeKeyAction(e.key, {
        scope: latest.current.scope,
        suggestions: latest.current.suggestions,
        transfer: latest.current.transfer,
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
  }, [enabled, rootRef]);
}

/**
 * Web: after a pointer press, the pressed button lets go of focus, so Enter
 * keeps its documented meaning (confirm the focused row's top suggestion) and
 * never re-presses Skip or Confirm. Mounted once by the page.
 */
export function useBlurAfterPointerPress(): void {
  useEffect(() => {
    if (process.env.EXPO_OS !== 'web' || typeof document === 'undefined') return undefined;
    const onClick = (e: MouseEvent) => {
      const control = controlToBlur(e.target as HTMLElement | null, e.detail) as HTMLElement | null;
      control?.blur();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
}

/**
 * True while a text field has focus. The toast hides its Z key cap then (Z types
 * a letter in a field), leaving the Undo button as the cue.
 */
export function useFieldFocused(): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (process.env.EXPO_OS !== 'web' || typeof document === 'undefined') return undefined;
    const update = () => setFocused(isTypingTarget(document.activeElement as HTMLElement | null));
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);
  return focused;
}
