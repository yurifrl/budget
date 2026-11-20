import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { KVStore } from '@/platform/storage/types';
import { saveSessionToken } from '@/platform/storage/sessionToken';
import { changeTokenDead, CHANGE_LINK_EXPIRED, failureMessage, GENERIC_FAILURE, type PasswordFailure } from './password.logic';
import { passwordComplete, passwordLogin } from './passwordApi';

/** Where the e-mail + password flow is: the sign-in form, or the forced "choose a new password" step. */
export type PasswordStep = { kind: 'form' } | { kind: 'change'; email: string };

export interface PasswordSignIn {
  step: PasswordStep;
  error: string | null;
  /** The e-mail last typed at sign-in; kept when a dead change token sends the person back. */
  email: string;
  busy: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  /** Finish the temporary-password step with the chosen password. */
  choose: (newPassword: string) => Promise<void>;
  /** Abandon the new-password step (drops the change token). */
  cancel: () => void;
}

/**
 * Wiring for the password flow (the decisions are in password.logic.ts, the
 * requests in passwordApi.ts). The change token and every password live only
 * here and in the form components' state: no redux, no storage, no URL.
 * Signed in = web: the API set the cookie; native: the token is stored; then
 * `refresh` re-probes the session like every other flow.
 */
export function usePasswordSignIn(apiUrl: string, storage: KVStore, refresh: () => void): PasswordSignIn {
  const native = Platform.OS !== 'web';
  const [step, setStep] = useState<PasswordStep>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  // The change token is not render state: a ref keeps it out of anything that is mirrored or logged.
  const changeToken = useRef<string | null>(null);

  const backToForm = useCallback((message: string | null) => {
    changeToken.current = null;
    setStep({ kind: 'form' });
    setError(message);
  }, []);

  const finish = useCallback(
    async (data: { token?: string | undefined }) => {
      if (native) {
        if (!data.token) return setError(GENERIC_FAILURE);
        try {
          await saveSessionToken(storage, data.token);
        } catch {
          return setError(GENERIC_FAILURE);
        }
      }
      changeToken.current = null;
      refresh();
    },
    [native, refresh, storage],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null);
      setEmail(email);
      setBusy(true);
      try {
        const r = await passwordLogin(apiUrl, { email, password, native });
        if (!r.ok) return setError(failureMessage('login', r.failure));
        if (r.data.status === 'password_change_required') {
          changeToken.current = r.data.change_token;
          setStep({ kind: 'change', email: r.data.email });
          return;
        }
        await finish(r.data);
      } finally {
        setBusy(false);
      }
    },
    [apiUrl, finish, native],
  );

  const choose = useCallback(
    async (newPassword: string) => {
      const token = changeToken.current;
      if (!token) return backToForm(CHANGE_LINK_EXPIRED);
      setError(null);
      setBusy(true);
      try {
        const r = await passwordComplete(apiUrl, { changeToken: token, newPassword, native });
        if (!r.ok) return fail(r.failure);
        await finish(r.data);
      } finally {
        setBusy(false);
      }

      function fail(f: PasswordFailure) {
        // A dead token cannot be retried: back to the sign-in form with the reason.
        if (changeTokenDead(f)) return backToForm(failureMessage('complete', f));
        setError(failureMessage('complete', f));
      }
    },
    [apiUrl, backToForm, finish, native],
  );

  const cancel = useCallback(() => backToForm(null), [backToForm]);

  return { step, error, email, busy, signIn, choose, cancel };
}
