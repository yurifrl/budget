/**
 * Native sign-in session persistence.
 *
 * The API session is an httpOnly cookie scoped to the web origin, which a
 * native app's fetches can never see. The native flow therefore ends with the
 * API handing the app a stateless session token (see server/authz.ts
 * /auth/token), stored here and sent as `Authorization: Bearer` on every
 * request — see platform/api/baseQuery.ts and auth/useAuth.ts.
 *
 * Where it lives: on native, the Keychain (`platformSecretStore`,
 * expo-secure-store). Builds before phase 5e kept it in AsyncStorage (the
 * KVStore); the first read moves such a token into the Keychain and deletes
 * the AsyncStorage copy. With no secret store (web, tests) the KVStore is
 * used as before. Callers keep passing the KVStore; `secret` is injectable
 * for tests.
 */

import { platformSecretStore } from './secretStore';
import type { KVStore, SecretStore } from './types';

const SESSION_TOKEN_KEY = 'auth.sessionToken';

/** Read the stored native session token, or null when signed out. */
export async function loadSessionToken(
  storage: KVStore,
  secret: SecretStore | null = platformSecretStore,
): Promise<string | null> {
  if (!secret) return (await storage.get<string | null>(SESSION_TOKEN_KEY, null)) ?? null;
  const stored = await secret.get(SESSION_TOKEN_KEY);
  if (stored) return stored;
  // One-time migration from the AsyncStorage copy older builds wrote.
  const legacy = await storage.get<string | null>(SESSION_TOKEN_KEY, null);
  if (!legacy) return null;
  await secret.set(SESSION_TOKEN_KEY, legacy);
  await storage.remove(SESSION_TOKEN_KEY);
  return legacy;
}

/** Persist the native session token issued by the API. */
export function saveSessionToken(
  storage: KVStore,
  token: string,
  secret: SecretStore | null = platformSecretStore,
): Promise<void> {
  return secret ? secret.set(SESSION_TOKEN_KEY, token) : storage.set(SESSION_TOKEN_KEY, token);
}

/** Drop the native session token (sign-out), wherever it is stored. */
export async function clearSessionToken(
  storage: KVStore,
  secret: SecretStore | null = platformSecretStore,
): Promise<void> {
  if (secret) await secret.remove(SESSION_TOKEN_KEY);
  await storage.remove(SESSION_TOKEN_KEY);
}

/** Build the Bearer auth header pair for a stored token, if any. */
export async function loadAuthHeaders(
  storage: KVStore,
  secret: SecretStore | null = platformSecretStore,
): Promise<Record<string, string>> {
  const token = await loadSessionToken(storage, secret);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
