/**
 * useAccountsToast: the Accounts screen's transient toast ("Account
 * reconciled", "Linked N accounts"). Auto-hides after 3 s.
 */

import { useEffect, useState } from 'react';

import { linkedToastText } from './reconcile.logic';

export function useAccountsToast(linkedParam: string | undefined) {
  // Success toast (syscd-app-qfr): "Account reconciled", auto-hides.
  const [toast, setToast] = useState<string | null>(null);

  // Toast auto-hide (syscd-app-qfr).
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  // The connect flow lands here with ?linked=N — show its outcome count once.
  const linkedCount = linkedParam ? Number(linkedParam) : 0;
  useEffect(() => {
    if (linkedCount > 0) {
      setToast(linkedToastText(linkedCount));
    }
    // Only on mount/param change — the toast state owns dismissal.
  }, [linkedCount]);

  return [toast, setToast] as const;
}
