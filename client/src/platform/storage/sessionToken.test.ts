import { describe, expect, test } from 'bun:test';

import { MemoryKVStore } from './memory';
import { clearSessionToken, loadAuthHeaders, loadSessionToken, saveSessionToken } from './sessionToken';

describe('loadAuthHeaders (Bearer headers used for expo-image avatar fetches on native)', () => {
  test('empty headers when signed out (auth-disabled dev: image fetch goes unauthenticated)', async () => {
    expect(await loadAuthHeaders(new MemoryKVStore())).toEqual({});
  });

  test('Bearer header once a token is stored, and empty again after sign-out', async () => {
    const store = new MemoryKVStore();
    await saveSessionToken(store, 'tok123');
    expect(await loadAuthHeaders(store)).toEqual({ Authorization: 'Bearer tok123' });
    await clearSessionToken(store);
    expect(await loadAuthHeaders(store)).toEqual({});
  });
});

/** In-memory stand-in for the Keychain. */
function fakeSecret() {
  const map = new Map<string, string>();
  return {
    map,
    store: {
      get: async (k: string) => map.get(k) ?? null,
      set: async (k: string, v: string) => void map.set(k, v),
      remove: async (k: string) => void map.delete(k),
    },
  };
}

describe('session token in the Keychain (native)', () => {
  test('save/load/clear go to the secret store, never to the KVStore', async () => {
    const kv = new MemoryKVStore();
    const { map, store } = fakeSecret();
    await saveSessionToken(kv, 'tok-k', store);
    expect(map.get('auth.sessionToken')).toBe('tok-k');
    expect(await kv.get('auth.sessionToken', null)).toBeNull();
    expect(await loadSessionToken(kv, store)).toBe('tok-k');
    expect(await loadAuthHeaders(kv, store)).toEqual({ Authorization: 'Bearer tok-k' });
    await clearSessionToken(kv, store);
    expect(await loadSessionToken(kv, store)).toBeNull();
  });

  test('a token left in AsyncStorage by an older build moves to the Keychain once', async () => {
    const kv = new MemoryKVStore({ 'auth.sessionToken': 'legacy-tok' });
    const { map, store } = fakeSecret();
    expect(await loadSessionToken(kv, store)).toBe('legacy-tok');
    expect(map.get('auth.sessionToken')).toBe('legacy-tok');
    expect(await kv.get('auth.sessionToken', null)).toBeNull();
    expect(await loadSessionToken(kv, store)).toBe('legacy-tok');
  });

  test('the Keychain wins over a stale AsyncStorage copy; sign-out clears both', async () => {
    const kv = new MemoryKVStore({ 'auth.sessionToken': 'stale' });
    const { store } = fakeSecret();
    await store.set('auth.sessionToken', 'fresh');
    expect(await loadSessionToken(kv, store)).toBe('fresh');
    await clearSessionToken(kv, store);
    expect(await loadSessionToken(kv, store)).toBeNull();
    expect(await kv.get('auth.sessionToken', null)).toBeNull();
  });
});
