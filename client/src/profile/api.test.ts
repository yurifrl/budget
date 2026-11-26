/**
 * The key screen and the Categorize card read the same server fact — whether a
 * Jev key can be used — from two different RTK Query slices. Saving or removing
 * the key must refresh the card's cached answer; otherwise the card keeps
 * saying there is no key until a reload.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { budgetApi } from '@/budget/data/api';
import { Container } from '@/platform/di/container';
import { Tokens } from '@/platform/di/tokens';
import type { KVStore } from '@/platform/storage/types';
import { createAppStore } from '@/state/store';

import { profileApi } from './api';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const budgetId = '11111111-1111-4111-8111-111111111111';

/** Answers the two endpoints these slices call, counting run-status reads. */
function stubFetch(): { runStatus: number; key: number } {
  const calls = { runStatus: 0, key: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/categorize/run')) {
      calls.runStatus += 1;
      return Response.json({
        budget_id: budgetId,
        configured: true,
        reason: null,
        candidates: 0,
        run: null,
      });
    }
    calls.key += 1;
    return Response.json({
      saved_at: null,
      last_four: null,
      using_server_key: false,
      can_use_server_key: true,
      unreadable: false,
    });
  }) as unknown as typeof fetch;
  return calls;
}

/** Wait for the refetch an invalidation schedules (it runs after the mutation). */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the run status was never refetched');
}

describe('the Jev key mutations', () => {
  test('saving and removing the key refresh the Categorize run status', async () => {
    const calls = stubFetch();
    const container = new Container();
    container.registerValue(Tokens.Config, { apiUrl: 'http://api.test', connectionsProvider: 'pluggy' });
    container.registerValue(Tokens.Storage, {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    } as unknown as KVStore);
    const store = createAppStore(container, { listeners: false });

    const runStatus = store.dispatch(budgetApi.endpoints.getCategorizeRun.initiate({ budgetId }));
    await runStatus;
    expect(calls.runStatus).toBe(1);

    await store.dispatch(profileApi.endpoints.saveJevKey.initiate({ key: 'sk-or-v1-0123456789abcdef' }));
    await until(() => calls.runStatus === 2);
    expect(calls.key).toBe(1);

    await store.dispatch(profileApi.endpoints.deleteJevKey.initiate());
    await until(() => calls.runStatus === 3);
    expect(calls.key).toBe(2);

    runStatus.unsubscribe();
  });
});
