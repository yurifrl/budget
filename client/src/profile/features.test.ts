/**
 * The features query of the profile api, driven through the real app store
 * (no React renderer in the repo): request shape, defaults laid under the
 * answer, and a refetch when the app regains focus.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { Container } from '@/platform/di/container';
import { Tokens } from '@/platform/di/tokens';
import type { KVStore } from '@/platform/storage/types';
import { createAppStore } from '@/state/store';

import { MY_FEATURES_REFETCH, myFeaturesRequest, profileApi } from './api';

const BASE = 'http://api.test:3999';

function makeStore() {
  const storage = { get: async () => null, set: async () => {}, remove: async () => {} } as unknown as KVStore;
  const container = new Container()
    .registerValue(Tokens.Config, { apiUrl: BASE, connectionsProvider: 'test-provider' })
    .registerValue(Tokens.Storage, storage);
  return createAppStore(container, { listeners: false });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Each call answers with the next body (the last one repeats); returns the urls called. */
function stubFeatures(...bodies: unknown[]): string[] {
  const calls: string[] = [];
  globalThis.fetch = Object.assign(async (url: string) => {
    const body = bodies[Math.min(calls.length, bodies.length - 1)];
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }, originalFetch) as typeof fetch;
  return calls;
}

const selectFeatures = profileApi.endpoints.getMyFeatures.select();
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('my features (profile api)', () => {
  test('the request is GET /features with no params or body', () => {
    expect(myFeaturesRequest()).toEqual({ url: '/features', method: 'GET' });
  });

  test('the hook options ask for a refetch on focus and on reconnect, and no polling', () => {
    expect(MY_FEATURES_REFETCH).toEqual({ refetchOnFocus: true, refetchOnReconnect: true });
  });

  test('the answer is laid over the defaults: unknown keys dropped, missing ones filled', async () => {
    const calls = stubFeatures({ features: { 'shared-pluggy-key': true, 'retired-feature': true } });
    const store = makeStore();
    const sub = store.dispatch(profileApi.endpoints.getMyFeatures.initiate());
    expect((await sub).data).toEqual({ 'shared-pluggy-key': true });
    expect(calls).toEqual([`${BASE}/features`]);
    sub.unsubscribe();

    stubFeatures({ features: {} });
    const other = makeStore();
    const sub2 = other.dispatch(profileApi.endpoints.getMyFeatures.initiate());
    expect((await sub2).data).toEqual({ 'shared-pluggy-key': false });
    sub2.unsubscribe();
  });

  test('regaining focus refetches, so a change made by an admin arrives without a reload', async () => {
    const calls = stubFeatures({ features: { 'shared-pluggy-key': false } }, { features: { 'shared-pluggy-key': true } });
    const store = makeStore();
    const sub = store.dispatch(profileApi.endpoints.getMyFeatures.initiate(undefined, { subscriptionOptions: MY_FEATURES_REFETCH }));
    await sub;
    expect(selectFeatures(store.getState()).data).toEqual({ 'shared-pluggy-key': false });
    expect(calls.length).toBe(1);

    // Nothing polls while the app just sits there.
    await settle();
    expect(calls.length).toBe(1);

    store.dispatch(profileApi.internalActions.onFocus());
    await settle();
    expect(calls.length).toBe(2);
    expect(selectFeatures(store.getState()).data).toEqual({ 'shared-pluggy-key': true });

    store.dispatch(profileApi.internalActions.onOnline());
    await settle();
    expect(calls.length).toBe(3);
    sub.unsubscribe();
  });

  test('without the focus option the same signal does not refetch (the option is what does it)', async () => {
    const calls = stubFeatures({ features: {} });
    const store = makeStore();
    const sub = store.dispatch(profileApi.endpoints.getMyFeatures.initiate());
    await sub;
    store.dispatch(profileApi.internalActions.onFocus());
    await settle();
    expect(calls.length).toBe(1);
    sub.unsubscribe();
  });
});
