import { describe, expect, it } from 'bun:test';

import { BUDGET_UI_KEY, setActiveBudget } from '@/budget/state/ui';
import { Container, token } from '@/platform/di/container';
import { resetAppState } from '@/platform/state/reset';

import { createAppStore } from './store';

describe('createAppStore', () => {
  it('mounts the budgetUi slice and both api slices', () => {
    const state = createAppStore(new Container(), { listeners: false }).getState();
    expect(state).toHaveProperty(BUDGET_UI_KEY);
    expect(state).toHaveProperty('budgetApi');
    expect(state).toHaveProperty('profileApi');
  });

  it('exposes the container as the thunk extra argument', () => {
    const container = new Container();
    const Probe = token<string>('Probe');
    container.registerValue(Probe, 'resolved');
    const store = createAppStore(container, { listeners: false });

    let seen: string | undefined;
    store.dispatch((_dispatch, _getState, extra: Container) => {
      seen = extra.resolve(Probe);
    });
    expect(seen).toBe('resolved');
  });

  it('resetAppState returns every slice to its initial state', () => {
    const store = createAppStore(new Container(), { listeners: false });
    store.dispatch(setActiveBudget('b1'));
    expect(store.getState()[BUDGET_UI_KEY].activeBudgetId).toBe('b1');
    store.dispatch(resetAppState());
    expect(store.getState()[BUDGET_UI_KEY].activeBudgetId).toBeNull();
  });
});
