import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, test } from 'bun:test';

import { MemoryKVStore } from '@/platform/storage/memory';

import { DEFAULT_FLAG_LABELS } from '../domain/flagLabels';
import { DEFAULT_FMT_PREFS } from '../domain/fmtPrefs';
import { createBudgetSettingsListener, settingsPatchFor } from './budgetSettings';
import {
  BUDGET_UI_KEY,
  budgetSettingsLoaded,
  budgetUiReducer,
  setActiveBudget,
  setFlagLabel,
  setFmtPrefs,
  setMoneyMasked,
  setShowClosedAccounts,
  setShowProgressBars,
  toggleProgressBars,
} from './ui';

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeStore(storage: MemoryKVStore) {
  const listener = createBudgetSettingsListener(() => storage);
  return configureStore({
    reducer: { [BUDGET_UI_KEY]: budgetUiReducer },
    middleware: (gdm) => gdm().prepend(listener.middleware),
  });
}

describe('budgetUi settings reducers', () => {
  const init = () => budgetUiReducer(undefined, { type: '@@INIT' });

  test('defaults: pt-BR prefs, blank flag labels, unmasked', () => {
    const s = init();
    expect(s.fmt).toEqual(DEFAULT_FMT_PREFS);
    expect(s.flagLabels).toEqual(DEFAULT_FLAG_LABELS);
    expect(s.moneyMasked).toBe(false);
  });

  test('budgetSettingsLoaded merges fmt, resets labels to defaults+blob, defaults display toggles', () => {
    let s = budgetUiReducer(init(), setFmtPrefs({ numberLocale: 'en-US' }));
    s = budgetUiReducer(s, setShowProgressBars(false));
    s = budgetUiReducer(s, budgetSettingsLoaded({ fmt: { dateFormat: 'MM/DD/YYYY' }, flagLabels: { red: 'Bills' } }));
    expect(s.fmt).toEqual({ ...DEFAULT_FMT_PREFS, numberLocale: 'en-US', dateFormat: 'MM/DD/YYYY' });
    expect(s.flagLabels).toEqual({ ...DEFAULT_FLAG_LABELS, red: 'Bills' });
    expect(s.showProgressBars).toBe(true);
    expect(s.showHiddenCategories).toBe(true);
    expect(s.showClosedAccounts).toBe(false);
  });

  test('a blob without fmt/flagLabels keeps the current ones (as applyBudgetSettings did)', () => {
    let s = budgetUiReducer(init(), setFmtPrefs({ numberLocale: 'en-US' }));
    s = budgetUiReducer(s, setFlagLabel({ color: 'blue', label: 'Trips' }));
    s = budgetUiReducer(s, budgetSettingsLoaded({ display: { closedAccounts: true } }));
    expect(s.fmt.numberLocale).toBe('en-US');
    expect(s.flagLabels.blue).toBe('Trips');
    expect(s.showClosedAccounts).toBe(true);
  });

  test('setMoneyMasked toggles the mask', () => {
    expect(budgetUiReducer(init(), setMoneyMasked(true)).moneyMasked).toBe(true);
  });
});

describe('settingsPatchFor', () => {
  const state = (s = budgetUiReducer(undefined, { type: '@@INIT' })) => ({ [BUDGET_UI_KEY]: s });

  test('fmt writes the delta, a flag label writes the whole map, toggles one display key', () => {
    expect(settingsPatchFor(setFmtPrefs({ currency: 'USD' }), state())).toEqual({ fmt: { currency: 'USD' } });
    const after = budgetUiReducer(undefined, setFlagLabel({ color: 'red', label: 'x' }));
    expect(settingsPatchFor(setFlagLabel({ color: 'red', label: 'x' }), state(after))).toEqual({
      flagLabels: { ...DEFAULT_FLAG_LABELS, red: 'x' },
    });
    expect(settingsPatchFor(setShowClosedAccounts(true), state())).toEqual({ display: { closedAccounts: true } });
  });

  test('non-persisted actions (the Plan toolbar toggles, the mask) write nothing', () => {
    expect(settingsPatchFor(toggleProgressBars(), state())).toBeNull();
    expect(settingsPatchFor(setMoneyMasked(true), state())).toBeNull();
  });
});

describe('createBudgetSettingsListener', () => {
  test('switching budget hydrates from that budget blob', async () => {
    const storage = new MemoryKVStore({
      'budget.settings.b2': { fmt: { numberLocale: 'en-US' }, display: { progressBars: false } },
    });
    const store = makeStore(storage);
    store.dispatch(setActiveBudget('b2'));
    await flush();
    expect(store.getState()[BUDGET_UI_KEY].fmt.numberLocale).toBe('en-US');
    expect(store.getState()[BUDGET_UI_KEY].showProgressBars).toBe(false);
  });

  test('a stale load (switched again before it returned) is dropped', async () => {
    const storage = new MemoryKVStore({ 'budget.settings.b1': { fmt: { numberLocale: 'en-US' } } });
    const store = makeStore(storage);
    store.dispatch(setActiveBudget('b1'));
    store.dispatch(setActiveBudget('b2'));
    await flush();
    expect(store.getState()[BUDGET_UI_KEY].fmt.numberLocale).toBe('pt-BR');
  });

  test('settings actions persist a sectioned patch for the active budget, in order', async () => {
    const storage = new MemoryKVStore({ 'budget.settings.b1': { fmt: { currency: 'USD' }, display: { closedAccounts: true } } });
    const store = makeStore(storage);
    store.dispatch(setActiveBudget('b1'));
    await flush();
    store.dispatch(setFmtPrefs({ numberLocale: 'en-US' }));
    for (const label of ['B', 'Bi', 'Bil', 'Bills']) store.dispatch(setFlagLabel({ color: 'red', label }));
    store.dispatch(setShowProgressBars(false));
    store.dispatch(toggleProgressBars());
    await flush();
    await flush();
    expect(await storage.get('budget.settings.b1', {})).toEqual({
      fmt: { currency: 'USD', numberLocale: 'en-US' },
      flagLabels: { ...DEFAULT_FLAG_LABELS, red: 'Bills' },
      display: { closedAccounts: true, progressBars: false },
    });
  });

  test('nothing is written without an active budget', async () => {
    const storage = new MemoryKVStore();
    const store = makeStore(storage);
    store.dispatch(setFmtPrefs({ numberLocale: 'en-US' }));
    await flush();
    expect(await storage.get('budget.settings.null', null)).toBeNull();
  });
});
