/**
 * A clock for the pending-skip countdown: ticks once a second while `active`
 * and reads the time again at once whenever `resetKey` changes (a new skip
 * began), so a fresh skip never shows more than its window.
 */

import { useEffect, useState } from 'react';

export function useNow(active: boolean, resetKey: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, resetKey]);
  return now;
}
