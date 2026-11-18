/**
 * planEdits — undo/redo + Recent Moves history tests (syscd-app-ijn).
 *
 * Pure-logic tests cover the stack bookkeeping and the before/after snapshot
 * builders over a hand-built budget. Thunk tests drive the REAL budgetApi
 * slice through a store with a stubbed globalThis.fetch (repo convention,
 * core/api/baseQuery.test.ts) and assert the undo/redo/revert writes the
 * recorded absolute cents to `/assignments/batch`.
 */

import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, test } from 'bun:test';

import { Container } from '@/platform/di/container';
import { Tokens } from '@/platform/di/tokens';
import type { KVStore } from '@/platform/storage/types';

import { budgetApi } from '../data/api';
import { moveMoneyUpdates } from '../data/ledger';
import type { Budget, MonthKey } from '../domain/types';
import {
  formatPlanEditAge,
  initialPlanEdits,
  makeAssignEdit,
  makeAutoAssignEdit,
  makeMoveEdit,
  makeMultiMoveEdit,
  movePlanEditRevertToFuture,
  movePlanEditToFuture,
  movePlanEditToPast,
  newPlanEdit,
  PLAN_EDIT_HISTORY_LIMIT,
  pushPlanEdit,
  RECENT_MOVES_LIMIT,
  selectRecentPlanEdits,
  type PlanEditEntry,
  type PlanEditsState,
} from './planEdits';
import { redoPlanEdit, revertPlanEdit, undoPlanEdit } from './planEditsThunks';
import { BUDGET_UI_KEY, budgetUiReducer, recordPlanEdit, setActiveBudget, type BudgetUiRootState } from './ui';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE = 'http://api.test:3999';
const MONTH: MonthKey = 202606;

const budget: Budget = {
    bundles: [],
  id: 'b-1',
  name: 'Test',
  currentMonth: MONTH,
  months: [MONTH],
  accounts: [],
  groups: [{ id: 'grp-1', name: 'G1', categoryIds: ['cat-a', 'cat-b'] }],
  categories: [
    { id: 'cat-a', groupId: 'grp-1', name: 'Alpha', assigned: { [MONTH]: 10000 }, activity: {} },
    { id: 'cat-b', groupId: 'grp-1', name: 'Beta', assigned: { [MONTH]: 20000 }, activity: {} },
  ],
  transactions: [],
};

const draft = (overrides: Partial<Parameters<typeof newPlanEdit>[0]> = {}) => ({
  kind: 'assign' as const,
  budgetId: 'b-1',
  month: MONTH,
  label: 'Assign +R$ 10 · Alpha',
  updates: [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 10000, after: 11000 }],
  ...overrides,
});

const entry = (id: string, updates: PlanEditEntry['updates'], now = 1_000): PlanEditEntry => ({
  ...newPlanEdit({ kind: 'assign', budgetId: 'b-1', month: MONTH, label: 'e', updates }, now),
  id,
});

const withPast = (...entries: PlanEditEntry[]): PlanEditsState => {
  const state = initialPlanEdits();
  for (const e of entries) pushPlanEdit(state, e);
  return state;
};

// ---------------------------------------------------------------------------
// Stack bookkeeping
// ---------------------------------------------------------------------------

describe('pushPlanEdit', () => {
  test('appends to past and truncates the redo stack', () => {
    const state = initialPlanEdits();
    const e1 = entry('pe-1', [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 0, after: 1000 }]);
    const e2 = entry('pe-2', [{ categoryId: 'cat-b', categoryName: 'Beta', before: 0, after: 500 }]);
    pushPlanEdit(state, e1);
    movePlanEditToFuture(state);
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(1);
    pushPlanEdit(state, e2);
    expect(state.past).toEqual([e2]);
    expect(state.future).toEqual([]);
  });

  test('caps past at the history limit (oldest dropped)', () => {
    const state = initialPlanEdits();
    for (let i = 0; i < PLAN_EDIT_HISTORY_LIMIT + 1; i += 1) {
      pushPlanEdit(state, entry(`pe-${i}`, [{ categoryId: 'cat-a', categoryName: 'Alpha', before: i, after: i + 1 }], i * 1000));
    }
    expect(state.past).toHaveLength(PLAN_EDIT_HISTORY_LIMIT);
    expect(state.past[0].id).toBe('pe-1');
  });

  test('chains before from the top entry when the caller snapshot is stale', () => {
    const state = withPast(entry('pe-1', [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 0, after: 2000 }]));
    // Caller snapshot still says before=0, but the top entry already set 2000.
    pushPlanEdit(state, entry('pe-2', [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 0, after: 3000 }]));
    expect(state.past[1].updates[0].before).toBe(2000);
  });

  test('drops fully-null edits (no category actually changes)', () => {
    const state = withPast(entry('pe-1', [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 10000, after: 10000 }]));
    expect(state.past).toHaveLength(0);
  });

  test('keeps an edit whose chained snapshot says it does change', () => {
    const state = withPast(entry('pe-1', [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 0, after: 2000 }]));
    // Caller snapshot says before=2000 (stale), and the edit moves to 3000.
    pushPlanEdit(state, entry('pe-2', [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 2000, after: 3000 }]));
    expect(state.past).toHaveLength(2);
    expect(state.past[1].updates[0].before).toBe(2000);
  });

  test('does not chain across budget or month boundaries', () => {
    const state = withPast(entry('pe-1', [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 0, after: 2000 }]));
    pushPlanEdit(state, { ...entry('pe-2', [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 500, after: 3000 }]), month: 202607 });
    expect(state.past[1].updates[0].before).toBe(500);
  });
});

describe('stack moves', () => {
  test('undo/redo bookkeeping round-trips the newest entry', () => {
    const state = withPast(entry('pe-1', [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 0, after: 1000 }]));
    movePlanEditToFuture(state);
    expect(state.past).toHaveLength(0);
    expect(state.future[0].id).toBe('pe-1');
    movePlanEditToPast(state);
    expect(state.past[0].id).toBe('pe-1');
    expect(state.future).toHaveLength(0);
  });

  test('revert removes the entry from the middle of past and appends it to future', () => {
    const state = withPast(
      entry('pe-1', [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 0, after: 1000 }]),
      entry('pe-2', [{ categoryId: 'cat-b', categoryName: 'Beta', before: 0, after: 1000 }]),
      entry('pe-3', [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 1000, after: 2000 }]),
    );
    movePlanEditRevertToFuture(state, 'pe-2');
    expect(state.past.map((e) => e.id)).toEqual(['pe-1', 'pe-3']);
    expect(state.future.map((e) => e.id)).toEqual(['pe-2']);
  });

  test('newPlanEdit ids are unique even within the same ms', () => {
    expect(newPlanEdit(draft(), 1_000).id).not.toBe(newPlanEdit(draft(), 1_000).id);
  });
});

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

describe('makeAssignEdit', () => {
  test('captures before from the budget and builds an assign label', () => {
    const edit = makeAssignEdit(budget, 'b-1', MONTH, 'cat-a', 15000);
    expect(edit).not.toBeNull();
    expect(edit!.kind).toBe('assign');
    expect(edit!.updates).toEqual([{ categoryId: 'cat-a', categoryName: 'Alpha', before: 10000, after: 15000 }]);
    expect(edit!.label).toContain('+');
    expect(edit!.label).toContain('Alpha');
    expect(edit!.month).toBe(MONTH);
  });

  test('is null for same-value and unknown-category edits', () => {
    expect(makeAssignEdit(budget, 'b-1', MONTH, 'cat-a', 10000)).toBeNull();
    expect(makeAssignEdit(budget, 'b-1', MONTH, 'cat-nope', 15000)).toBeNull();
  });

  test('missing month means 0 assigned', () => {
    const edit = makeAssignEdit(budget, 'b-1', 202601, 'cat-a', 5000);
    expect(edit!.updates[0].before).toBe(0);
  });
});

describe('makeMoveEdit', () => {
  test('category → Ready to Assign: single update, RTA label only', () => {
    const edit = makeMoveEdit(budget, 'b-1', MONTH, 'cat-a', null, 4000);
    expect(edit!.updates).toEqual([{ categoryId: 'cat-a', categoryName: 'Alpha', before: 10000, after: 6000 }]);
    expect(edit!.label).toBe('Move R$\u00A040,00 · Alpha → Ready to Assign');
  });

  test('Ready to Assign → category', () => {
    const edit = makeMoveEdit(budget, 'b-1', MONTH, null, 'cat-b', 5000);
    expect(edit!.updates).toEqual([{ categoryId: 'cat-b', categoryName: 'Beta', before: 20000, after: 25000 }]);
  });

  test('label and updates agree with the ledger helper', () => {
    const edit = makeMoveEdit(budget, 'b-1', MONTH, 'cat-a', 'cat-b', 3000);
    expect(edit!.updates.map((u) => [u.categoryId, u.before, u.after])).toEqual(
      moveMoneyUpdates(budget, MONTH, 'cat-a', 'cat-b', 3000).map((u) => [
        u.categoryId,
        budget.categories.find((c) => c.id === u.categoryId)!.assigned[MONTH],
        u.assignedCents,
      ]),
    );
    expect(edit!.label).toBe('Move R$\u00A030,00 · Alpha → Beta');
  });

  test('is null for zero amounts and RTA→RTA moves', () => {
    expect(makeMoveEdit(budget, 'b-1', MONTH, 'cat-a', null, 0)).toBeNull();
    expect(makeMoveEdit(budget, 'b-1', MONTH, null, null, 5000)).toBeNull();
  });
});

describe('makeMultiMoveEdit', () => {
  test('folds several pairs into ONE undo step and aggregates the label', () => {
    const edit = makeMultiMoveEdit(budget, 'b-1', MONTH, [
      { from: 'cat-a', to: 'cat-b', amount: 3000 },
      { from: 'cat-a', to: null, amount: 2000 },
    ]);
    expect(edit!.updates.map((u) => [u.categoryId, u.before, u.after])).toEqual([
      ['cat-a', 10000, 5000],
      ['cat-b', 20000, 23000],
    ]);
    expect(edit!.label).toBe('Move R$\u00A050,00 · Alpha → Beta, Ready to Assign');
    expect(edit!.kind).toBe('move');
  });

  test('net-zero categories are dropped from the snapshot', () => {
    const edit = makeMultiMoveEdit(budget, 'b-1', MONTH, [
      { from: 'cat-a', to: 'cat-b', amount: 4000 },
      { from: 'cat-b', to: 'cat-a', amount: 4000 },
    ]);
    expect(edit).toBeNull();
  });
});

describe('makeAutoAssignEdit', () => {
  test('keeps only categories whose assignment changes; pluralizes label', () => {
    const edit = makeAutoAssignEdit(
      budget,
      'b-1',
      MONTH,
      [
        { categoryId: 'cat-a', assignCents: 12000, deltaCents: 2000 },
        { categoryId: 'cat-b', assignCents: 20000, deltaCents: 0 },
        { categoryId: 'cat-ghost', assignCents: 900, deltaCents: 900 },
      ],
      'Underfunded',
    );
    expect(edit!.updates).toEqual([{ categoryId: 'cat-a', categoryName: 'Alpha', before: 10000, after: 12000 }]);
    expect(edit!.label).toBe('Underfunded · 1 category');
  });

  test('is null when nothing changes', () => {
    expect(makeAutoAssignEdit(budget, 'b-1', MONTH, [{ categoryId: 'cat-a', assignCents: 10000, deltaCents: 0 }], 'X')).toBeNull();
    expect(makeAutoAssignEdit(budget, 'b-1', MONTH, [], 'X')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Selectors & formatting
// ---------------------------------------------------------------------------

describe('formatPlanEditAge', () => {
  const now = 10 * 24 * 3600 * 1000;
  test('branches: now, minutes, hours, days', () => {
    expect(formatPlanEditAge(now, now)).toBe('agora');
    expect(formatPlanEditAge(now - 3 * 60 * 1000, now)).toBe('3m');
    expect(formatPlanEditAge(now - 2 * 3600 * 1000, now)).toBe('2h');
    expect(formatPlanEditAge(now - 5 * 24 * 3600 * 1000, now)).toBe('5d');
    expect(formatPlanEditAge(now + 1000, now)).toBe('agora');
  });
});

describe('selectRecentPlanEdits', () => {
  test('lists most recent first, capped at the panel limit', () => {
    const root = {
      [BUDGET_UI_KEY]: {
        planEdits: withPast(
          ...Array.from({ length: RECENT_MOVES_LIMIT + 2 }, (_, i) =>
            entry(`pe-${i}`, [{ categoryId: 'cat-a', categoryName: 'Alpha', before: i, after: i + 1 }], i * 1000),
          ),
        ),
      },
    } as unknown as BudgetUiRootState;
    const recent = selectRecentPlanEdits(root);
    expect(recent).toHaveLength(RECENT_MOVES_LIMIT);
    expect(recent[0].id).toBe(`pe-${RECENT_MOVES_LIMIT + 1}`);
    expect(recent[1].id).toBe(`pe-${RECENT_MOVES_LIMIT}`);
  });
});

// ---------------------------------------------------------------------------
// Thunks — undo/redo/revert write contract over /assignments/batch
// ---------------------------------------------------------------------------

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  status: number;
}

let captured: Captured | null = null;

/** Repo convention (core/api/baseQuery.test.ts): swap globalThis.fetch, restore in finally. */
function stubFetch(status = 204): () => void {
  captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (url: string | URL, init?: RequestInit) => {
    captured = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      status,
    };
    return new Response(null, { status });
  }, originalFetch);
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function makeStore() {
  const container = new Container()
    .registerValue(Tokens.Config, { apiUrl: BASE, connectionsProvider: 'test-provider' })
    .registerValue(Tokens.Storage, {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    } as unknown as KVStore);
  return configureStore({
    reducer: {
      [BUDGET_UI_KEY]: budgetUiReducer,
      [budgetApi.reducerPath]: budgetApi.reducer,
    },
    middleware: (gdm) =>
      gdm({ thunk: { extraArgument: container } }).concat(budgetApi.middleware),
  });
}

async function storeWithOneEdit(): Promise<ReturnType<typeof makeStore>> {
  const store = makeStore();
  await store.dispatch(
    recordPlanEdit(newPlanEdit({
      kind: 'assign',
      budgetId: 'b-1',
      month: MONTH,
      label: 'Assign +R$ 10,00 · Alpha',
      updates: [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 10000, after: 11000 }],
    })),
  );
  return store;
}

describe('undoPlanEdit', () => {
  test('posts the before values to /assignments/batch and moves the entry to future', async () => {
    const restore = stubFetch();
    try {
      const store = await storeWithOneEdit();
      const undone = await store.dispatch(undoPlanEdit()).unwrap();
      expect(undone!.id).toBeTruthy();
      expect(captured!.url).toContain('/assignments/batch');
      expect(captured!.method).toBe('POST');
      expect(captured!.body).toEqual({
        budget_id: 'b-1',
        month: '2026-06-01',
        updates: [{ category_id: 'cat-a', budgeted: 100000 }],
      });
      const edits = (store.getState() as BudgetUiRootState)[BUDGET_UI_KEY].planEdits;
      expect(edits.past).toHaveLength(0);
      expect(edits.future).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test('resolves null on empty history without fetching', async () => {
    const restore = stubFetch();
    try {
      const store = makeStore();
      await expect(store.dispatch(undoPlanEdit()).unwrap()).resolves.toBeNull();
      expect(captured).toBeNull();
    } finally {
      restore();
    }
  });

  test('leaves the stacks intact when the write fails', async () => {
    const restore = stubFetch(500);
    try {
      const store = await storeWithOneEdit();
      const result = await store.dispatch(undoPlanEdit());
      expect(result.meta.requestStatus).toBe('rejected');
      const edits = (store.getState() as BudgetUiRootState)[BUDGET_UI_KEY].planEdits;
      expect(edits.past).toHaveLength(1);
      expect(edits.future).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe('redoPlanEdit', () => {
  test('posts the after values and moves the entry back to past', async () => {
    const restore = stubFetch();
    try {
      const store = await storeWithOneEdit();
      await store.dispatch(undoPlanEdit()).unwrap();
      const redone = await store.dispatch(redoPlanEdit()).unwrap();
      expect(redone!.updates[0].after).toBe(11000);
      expect(captured!.body).toEqual({
        budget_id: 'b-1',
        month: '2026-06-01',
        updates: [{ category_id: 'cat-a', budgeted: 110000 }],
      });
      const edits = (store.getState() as BudgetUiRootState)[BUDGET_UI_KEY].planEdits;
      expect(edits.past).toHaveLength(1);
      expect(edits.future).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test('resolves null when nothing is redoable', async () => {
    const restore = stubFetch();
    try {
      const store = await storeWithOneEdit();
      await expect(store.dispatch(redoPlanEdit()).unwrap()).resolves.toBeNull();
      expect(captured).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('revertPlanEdit', () => {
  test('reverts a specific entry by id and makes it redoable', async () => {
    const restore = stubFetch();
    try {
      const store = await storeWithOneEdit();
      await store.dispatch(
        recordPlanEdit(newPlanEdit({
          kind: 'move',
          budgetId: 'b-1',
          month: MONTH,
          label: 'Move R$ 5,00 · Alpha → Beta',
          updates: [{ categoryId: 'cat-a', categoryName: 'Alpha', before: 11000, after: 6000 }],
        })),
      );
      const { past } = (store.getState() as BudgetUiRootState)[BUDGET_UI_KEY].planEdits;
      const reverted = await store.dispatch(revertPlanEdit(past[0].id)).unwrap();
      expect(reverted!.id).toBe(past[0].id);
      expect(captured!.body).toEqual({
        budget_id: 'b-1',
        month: '2026-06-01',
        updates: [{ category_id: 'cat-a', budgeted: 100000 }],
      });
      const edits = (store.getState() as BudgetUiRootState)[BUDGET_UI_KEY].planEdits;
      expect(edits.past.map((e) => e.id)).toEqual([past[1].id]);
      expect(edits.future.map((e) => e.id)).toEqual([past[0].id]);
    } finally {
      restore();
    }
  });

  test('resolves null for an unknown id without fetching', async () => {
    const restore = stubFetch();
    try {
      const store = makeStore();
      await expect(store.dispatch(revertPlanEdit('pe-missing')).unwrap()).resolves.toBeNull();
      expect(captured).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('recordPlanEdit via the slice', () => {
  test('recorded edits survive in budgetUi and reset on budget switch', async () => {
    const store = await storeWithOneEdit();
    let edits = (store.getState() as BudgetUiRootState)[BUDGET_UI_KEY].planEdits;
    expect(edits.past).toHaveLength(1);
    expect(edits.past[0].label).toBe('Assign +R$ 10,00 · Alpha');
    store.dispatch(setActiveBudget('b-2'));
    edits = (store.getState() as BudgetUiRootState)[BUDGET_UI_KEY].planEdits;
    expect(edits.past).toHaveLength(0);
    expect(edits.future).toHaveLength(0);
  });
});
