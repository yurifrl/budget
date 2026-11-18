/**
 * Switch/restore thunk tests — the persisted-active-budget boundary (Phase 4).
 *
 * The active budget id must survive restarts through the injected KVStore, and
 * restore must never clobber an in-memory selection nor blur null vs undefined
 * (the shell's first-budget fallback reads the fulfilled payload).
 */

import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, test } from 'bun:test';

import { Container } from '@/platform/di/container';
import { Tokens } from '@/platform/di/tokens';
import type { KVStore } from '@/platform/storage/types';

import {
  ACTIVE_BUDGET_STORAGE_KEY,
  restoreActiveBudget,
  switchBudget,
} from './thunks';
import { BUDGET_UI_KEY, budgetUiReducer, setActiveBudget } from './ui';

function makeStorage(opts: { stored?: string | null; failGet?: boolean } = {}) {
  const sets: [string, unknown][] = [];
  const storage: KVStore = {
    get: async () => {
      if (opts.failGet) throw new Error('storage unavailable');
      return opts.stored ?? null;
    },
    set: async (key: string, value: unknown) => {
      sets.push([key, value]);
    },
    remove: async () => {},
  } as unknown as KVStore;
  return { storage, sets };
}

function makeStore(storage: KVStore) {
  const container = new Container().registerValue(Tokens.Storage, storage);
  return configureStore({
    reducer: { [BUDGET_UI_KEY]: budgetUiReducer },
    middleware: (gDM) => gDM({ thunk: { extraArgument: container } }),
  });
}

describe('switchBudget', () => {
  test('sets the active budget AND persists the id under the KV key', async () => {
    const { storage, sets } = makeStorage();
    const s = makeStore(storage);

    await s.dispatch(switchBudget('b-2'));

    expect(s.getState()[BUDGET_UI_KEY].activeBudgetId).toBe('b-2');
    expect(sets).toEqual([[ACTIVE_BUDGET_STORAGE_KEY, 'b-2']]);
  });
});

describe('restoreActiveBudget', () => {
  test('rehydrates a stored id into the UI state and fulfills with it', async () => {
    const { storage } = makeStorage({ stored: 'b-7' });
    const s = makeStore(storage);

    const action = await s.dispatch(restoreActiveBudget());

    expect(s.getState()[BUDGET_UI_KEY].activeBudgetId).toBe('b-7');
    expect(action.type).toBe(restoreActiveBudget.fulfilled.type);
    expect(action.payload).toBe('b-7');
  });

  test('with nothing stored: no clobber of in-memory selection, payload exactly null', async () => {
    const { storage } = makeStorage({ stored: null });
    const s = makeStore(storage);
    // In-memory selection survives a wiped store — restore must not write null back.
    s.dispatch(setActiveBudget('b-1'));

    const action = await s.dispatch(restoreActiveBudget());

    expect(s.getState()[BUDGET_UI_KEY].activeBudgetId).toBe('b-1');
    expect(action.type).toBe(restoreActiveBudget.fulfilled.type);
    // `undefined` is not a storage answer; the shell's gate reads the store, not this.
    expect(action.payload).toBe(null);
  });

  test('a budget already chosen this session (home page) is not overridden by the stored one', async () => {
    const { storage } = makeStorage({ stored: 'b-old' });
    const s = makeStore(storage);
    s.dispatch(setActiveBudget('b-picked'));

    await s.dispatch(restoreActiveBudget());

    expect(s.getState()[BUDGET_UI_KEY].activeBudgetId).toBe('b-picked');
  });

  test('propagates storage.get rejection instead of resolving silently', async () => {
    const { storage } = makeStorage({ failGet: true });
    const s = makeStore(storage);

    await expect(s.dispatch(restoreActiveBudget()).unwrap()).rejects.toThrow(
      'storage unavailable',
    );
  });
});
