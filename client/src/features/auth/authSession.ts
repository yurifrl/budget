/** What signed-in screens may do to the session: today, end it. Provided by the LoginGate. */
import { createContext, useContext } from 'react';

export interface AuthSession {
  /** Explicit sign-out; afterwards the landing page stays up until a sign-in button is pressed. */
  signOut: () => Promise<void>;
}

export const AuthSessionContext = createContext<AuthSession | null>(null);

export function useAuthSession(): AuthSession {
  const value = useContext(AuthSessionContext);
  if (!value) throw new Error('useAuthSession must be used inside the LoginGate');
  return value;
}
