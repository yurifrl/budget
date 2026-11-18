/**
 * Escape closes an anchored dropdown/card on web, unless something inside it
 * claimed that Escape first (an open select or a quick-math editor calls
 * preventDefault). The document listener runs in the capture phase (RN-web's
 * root stops bubbling keydowns), i.e. BEFORE the inner handlers, so the
 * decision is deferred to after the event has been dispatched.
 */
import { useEffect } from 'react';

type KeyEventLike = { key: string; defaultPrevented: boolean };

/** The deferred decision, pure for tests. */
export function onEscapeKey(e: KeyEventLike, close: () => void, defer: (fn: () => void) => void): void {
  if (e.key !== 'Escape') return;
  defer(() => {
    if (!e.defaultPrevented) close();
  });
}

/** Web only: close on an Escape nothing inside claimed. */
export function useEscapeToClose(close: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled || process.env.EXPO_OS !== 'web' || typeof document === 'undefined') return undefined;
    const onKey = (e: KeyboardEvent) => onEscapeKey(e, close, (fn) => setTimeout(fn, 0));
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [close, enabled]);
}
