/**
 * Rows left in the "Leaving uncategorized" strip when the page goes away
 * (in-app navigation, a budget switch). The page cannot ask a question while it
 * is being torn down, so it hands its pending skips to this small store and the
 * shell-hosted prompt asks: Send and leave / Keep them and leave / Stay.
 * Closing or reloading the tab runs none of this: the rows are simply not sent,
 * and come back next visit (the strip says so).
 *
 * "Stay" files the rows under `restore`; the next Categorize page opened for that
 * budget takes them back into its strip.
 */

import type { SkipEntry } from './accept.logic';

export interface HeldLeave {
  budgetId: string;
  entries: SkipEntry[];
}

export interface LeaveState {
  /** What each budget's Categorize page has in its strip right now. */
  live: Record<string, SkipEntry[]>;
  /** Rows waiting for the person's answer. */
  held: HeldLeave | null;
  /** Rows to put back into the strip of the next page opened for their budget. */
  restore: HeldLeave | null;
}

export function createLeaveStore() {
  let state: LeaveState = { live: {}, held: null, restore: null };
  const listeners = new Set<() => void>();
  const set = (next: LeaveState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The page reports its strip (empty included: a fresh page clears what an earlier one left). */
    publish(budgetId: string, entries: SkipEntry[]) {
      set({ ...state, live: { ...state.live, [budgetId]: entries } });
    },
    /**
     * The route or the active budget no longer matches the page the rows were
     * taken on: ask what to do with them. Returns true when the prompt opens.
     */
    holdIfLeft(where: { onCategorize: boolean; activeBudgetId: string | null }): boolean {
      if (state.held) return false;
      for (const [budgetId, entries] of Object.entries(state.live)) {
        if (entries.length === 0) continue;
        if (where.onCategorize && budgetId === where.activeBudgetId) continue;
        const { [budgetId]: _gone, ...rest } = state.live;
        set({ ...state, live: rest, held: { budgetId, entries } });
        return true;
      }
      return false;
    },
    /** Keep only what could not be sent (the prompt stays open for it). */
    narrow(entries: SkipEntry[]) {
      if (!state.held) return;
      set({ ...state, held: entries.length > 0 ? { ...state.held, entries } : null });
    },
    /** Sent, or kept-and-left: nothing is waiting any more. */
    clearHeld() {
      set({ ...state, held: null });
    },
    /** Stay: the held rows go back to the strip of the next page for their budget. */
    stay() {
      if (!state.held) return null;
      const held = state.held;
      set({ ...state, held: null, restore: held });
      return held;
    },
    /** A page for `budgetId` opened: take the rows it must show again, once. */
    takeRestore(budgetId: string): SkipEntry[] {
      if (!state.restore || state.restore.budgetId !== budgetId) return [];
      const entries = state.restore.entries;
      set({ ...state, restore: null });
      return entries;
    },
  };
}

export const leaveStore = createLeaveStore();

/** True while the route is the Categorize page (or something below it). */
export function onCategorizeRoute(pathname: string): boolean {
  return pathname === '/categorize' || pathname.startsWith('/categorize/');
}
