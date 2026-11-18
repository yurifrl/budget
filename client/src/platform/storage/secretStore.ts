/**
 * Secret storage for credentials (the native session token).
 *
 * Web and tests: none. The web session is an httpOnly cookie, so nothing
 * secret is ever stored by the client; sessionToken.ts falls back to the
 * KVStore (only reachable in tests). Native: `secretStore.native.ts`
 * (iOS Keychain via expo-secure-store).
 */

import type { SecretStore } from './types';

export const platformSecretStore: SecretStore | null = null;
