import { useCallback, useState } from 'react';

import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { checkChange, failureMessage, passwordChange } from '@/features/auth';

/**
 * Change-password wiring for the profile card. Plain fetch (see
 * features/auth/passwordApi.ts), so the passwords never reach the redux store.
 */
export function useChangePassword(email: string) {
  const apiUrl = useService(Tokens.Config).apiUrl;
  const storage = useService(Tokens.Storage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (current: string, next: string, confirm: string): Promise<boolean> => {
      const check = checkChange(current, next, confirm, email);
      if (!check.ok) {
        setError(check.error);
        return false;
      }
      setError(null);
      setBusy(true);
      try {
        const r = await passwordChange(apiUrl, storage, check.value);
        if (!r.ok) {
          setError(failureMessage('change', r.failure));
          return false;
        }
        return true;
      } finally {
        setBusy(false);
      }
    },
    [apiUrl, email, storage],
  );

  return { busy, error, submit, clearError: () => setError(null) } as const;
}
