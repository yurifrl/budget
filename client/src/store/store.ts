/**
 * The app's Redux Toolkit store, assembled statically (no module registry).
 *
 * Mounts the budget RTK Query api, the profile api and the budgetUi slice. The
 * thunk `extra` argument is the DI container, so thunks and RTK Query
 * baseQueries resolve injected services (API config, storage). Dispatching
 * `resetAppState` returns every slice, RTK Query caches included, to its
 * initial state.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit';

import { budgetApi } from '@/budget/data/api';
import { BUDGET_UI_KEY, budgetUiReducer } from '@/budget/state/ui';
import type { Container } from '@/platform/di/container';
import { setupStoreListeners } from '@/platform/state/listeners';
import { resetAppState } from '@/platform/state/reset';
import { profileApi } from '@/profile/api';

const combined = combineReducers({
  [BUDGET_UI_KEY]: budgetUiReducer,
  [budgetApi.reducerPath]: budgetApi.reducer,
  [profileApi.reducerPath]: profileApi.reducer,
});

type CombinedState = ReturnType<typeof combined>;

const rootReducer = (state: CombinedState | undefined, action: Parameters<typeof combined>[1]): CombinedState =>
  resetAppState.match(action) ? combined(undefined, action) : combined(state, action);

export function createAppStore(container: Container, { listeners = true }: { listeners?: boolean } = {}) {
  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        thunk: { extraArgument: container },
      }).concat(budgetApi.middleware, profileApi.middleware),
  });

  // Focus/reconnect signals for refetchOnFocus / refetchOnReconnect.
  if (listeners) setupStoreListeners(store.dispatch);

  return store;
}

export type AppStore = ReturnType<typeof createAppStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
