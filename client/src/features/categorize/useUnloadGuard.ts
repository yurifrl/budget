/**
 * Web: while rows wait in the "Leaving uncategorized" strip, closing or
 * reloading the tab (or a link that loads the page afresh) asks the browser's
 * own "Leave site?" question. Nothing is sent either way: leaving anyway just
 * means the rows are not sent and come back next visit, as the strip says.
 */

import { useEffect } from 'react';

export function useUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active || process.env.EXPO_OS !== 'web' || typeof window === 'undefined') return undefined;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Some browsers still read the legacy returnValue to decide whether to ask.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [active]);
}
