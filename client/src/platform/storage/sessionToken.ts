/**
 * Native sign-in session persistence.
 *
 * The API session is an httpOnly cookie scoped to the web origin, which a
 * native app's fetches can never see. The native flow therefore ends with the
 * API handing the app a stateless session token (see server/authz.ts
 * /auth/token), stored here and sent as `Authorization: Bearer` on every
 * request — see core/api/baseQuery.ts and modules/auth/useAuth.ts.
 */

import type { KVStore } from './types';

const SESSION_TOKEN_KEY = 'auth.sessionToken';

/** Read the stored native session token, or null when signed out. */
export async function loadSessionToken(storage: KVStore): Promise<string | null> {
  const value = await storage.get<string | null>(SESSION_TOKEN_KEY, null);
  return value ?? null;
}

/** Persist the native session token issued by the API. */
export function saveSessionToken(storage: KVStore, token: string): Promise<void> {
  return storage.set(SESSION_TOKEN_KEY, token);
}

/** Drop the native session token (sign-out). */
export function clearSessionToken(storage: KVStore): Promise<void> {
  return storage.remove(SESSION_TOKEN_KEY);
}

/** Build the Bearer auth header pair for a stored token, if any. */
export async function loadAuthHeaders(storage: KVStore): Promise<Record<string, string>> {
  const token = await loadSessionToken(storage);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
