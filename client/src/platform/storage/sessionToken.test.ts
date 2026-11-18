import { describe, expect, test } from 'bun:test';

import { MemoryKVStore } from './memory';
import { clearSessionToken, loadAuthHeaders, saveSessionToken } from './sessionToken';

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
