/**
 * Rows left in the "Leaving uncategorized" strip when the person navigates away
 * (another route, another budget). The page may still be alive behind the new
 * route (a stacked screen, a tab) or gone (a budget switch remounts it), and it
 * cannot ask a question while the route changes, so it publishes its strip here
 * and the shell-hosted prompt asks: Send and leave / Keep them and leave / Stay.
 *
 * - Send / Keep tell a page that is still alive what happened to its rows
 *   (`commands`), so it never shows rows that were sent or given up.
 * - Stay needs nothing from a live page (its strip is intact); for a page that is
 *   gone the rows go under `restore`, and the next page opened for that budget
 *   takes them back.
 *
 * Closing or reloading the tab runs none of this: the rows are simply not sent,
 * and come back next visit (the strip says so).
 */

import type { SkipEntry } from './accept.logic';

export interface HeldLeave {
  budgetId: string;
  entries: SkipEntry[];
}

/** What a still-alive page must do with rows the prompt dealt with. */
export interface LeaveCommand {
  budgetId: string;
  /** `sent`: the rows were sent for it; `discard`: they were given up. */
  kind: 'sent' | 'discard';
  ids: string[];
}

export interface LeaveState {
  /** What each budget's Categorize page has in its strip right now. */
  live: Record<string, SkipEntry[]>;
  /** Budgets whose page is gone (unmounted) with its last strip still in `live`. */
  closed: Record<string, true>;
  /** Rows waiting for the person's answer. */
  held: HeldLeave | null;
  /** Rows to put back into the strip of the next page opened for their budget. */
  restore: HeldLeave | null;
  commands: LeaveCommand[];
}

export function createLeaveStore() {
  let state: LeaveState = { live: {}, closed: {}, held: null, restore: null, commands: [] };
  const listeners = new Set<() => void>();
  const set = (next: LeaveState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const without = <T>(record: Record<string, T>, key: string) => {
    const { [key]: _gone, ...rest } = record;
    return rest;
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The page reports its strip (empty included: a fresh page clears what an earlier one left). */
    publish(budgetId: string, entries: SkipEntry[]) {
      set({ ...state, live: { ...state.live, [budgetId]: entries }, closed: without(state.closed, budgetId) });
    },
    /** The page was unmounted (a budget switch): its last strip stays for the prompt. */
    pageClosed(budgetId: string) {
      set({ ...state, closed: { ...state.closed, [budgetId]: true } });
    },
    /**
     * The route or the active budget no longer matches the page the rows were
     * taken on: ask what to do with them. Returns true when the prompt opens.
     */
    holdIfLeft(where: { onCategorize: boolean; activeBudgetId: string | null }): boolean {
      if (state.held) return false;
      for (const [budgetId, entries] of Object.entries(state.live)) {
        if (entries.length === 0) continue;
        if (where.onCategorize && budgetId === where.activeBudgetId && !state.closed[budgetId]) continue;
        set({ ...state, held: { budgetId, entries } });
        return true;
      }
      return false;
    },
    /**
     * Rows were dealt with (`sent`) or given up (`discard`): they leave the prompt
     * and the strip. Rows not listed stay held (a send that failed for some).
     */
    settle(kind: LeaveCommand['kind'], ids: string[]) {
      if (!state.held) return;
      const { budgetId } = state.held;
      const gone = new Set(ids);
      const left = state.held.entries.filter((entry) => !gone.has(entry.item.transactionId));
      const keep = (entries: SkipEntry[]) => entries.filter((entry) => !gone.has(entry.item.transactionId));
      const alive = !state.closed[budgetId];
      set({
        ...state,
        held: left.length > 0 ? { budgetId, entries: left } : null,
        live: { ...state.live, [budgetId]: keep(state.live[budgetId] ?? []) },
        commands: alive && ids.length > 0 ? [...state.commands, { budgetId, kind, ids }] : state.commands,
      });
    },
    /** A live page takes the commands meant for it, once. */
    takeCommands(budgetId: string): LeaveCommand[] {
      const mine = state.commands.filter((command) => command.budgetId === budgetId);
      if (mine.length === 0) return [];
      set({ ...state, commands: state.commands.filter((command) => command.budgetId !== budgetId) });
      return mine;
    },
    /** Stay: a live page still has its rows; a page that is gone gets them back on its next open. */
    stay(): HeldLeave | null {
      if (!state.held) return null;
      const held = state.held;
      const gone = state.closed[held.budgetId] === true;
      set({
        ...state,
        held: null,
        restore: gone ? held : state.restore,
        live: gone ? without(state.live, held.budgetId) : state.live,
      });
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

/**
 * ONE store per app, not per module evaluation: a plain module-level singleton
 * could be duplicated if the bundler evaluates the module again; the global keeps
 * the page, the shell and the prompt on the same copy.
 */
const GLOBAL_KEY = '__budgetCategorizeLeaveStore';
type Holder = { [GLOBAL_KEY]?: ReturnType<typeof createLeaveStore> };
const holder = globalThis as Holder;
export const leaveStore = (holder[GLOBAL_KEY] ??= createLeaveStore());

/** True while the route is the Categorize page (or something below it). */
export function onCategorizeRoute(pathname: string): boolean {
  return pathname === '/categorize' || pathname.startsWith('/categorize/');
}
