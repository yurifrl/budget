/**
 * The budget shell's context: what screens and the settings panes may ask
 * of the responsive shell (sheets, drawer, breakpoints). Its own module so
 * the panes the shell renders can use it without an import cycle.
 */
import { createContext, useContext } from 'react';

import type { Transaction } from '@/domain/types';

export interface BudgetShellState {
  isPhone: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  /** Top padding screens need to clear the ☰/⋯ chrome row (safe-area aware). */
  contentTopPad: number;
  /** Open the calculator add-transaction sheet; `prefill` seeds a new entry
   * (mobile category detail "＋ Transaction" pre-picks the category). */
  openAddTransaction: (prefill?: { categoryId?: string | null }) => void;
  /** Open the calculator sheet pre-filled to edit an existing transaction. */
  openEditTransaction: (txn: Transaction) => void;
  /** Open the CSV import-transactions sheet. */
  openImportTransactions: () => void;
  /** Open the Manage Payees page (/payees route). */
  openPayees: () => void;
  /** Leave the budget for the home page (all budgets). */
  goHome: () => void;
  /** Collapse the chrome overlaying content: the drawer (tablet/phone). No-op on
   * desktop, where the rail sits beside content and must keep the user's
   * persisted collapse preference. */
  closeSidebar: () => void;
  /** True while the plan screen's row-tap numpad panel is open: the shell
   * parks its FAB (and anything else bottom-anchored) so it stops covering
   * the panel's keypad. */
  numpadOpen: boolean;
  /** Screens with a bottom panel report it here (mount → true, unmount → false). */
  setNumpadOpen: (open: boolean) => void;
  /** Open the settings menu on the People pane (add/remove who shares this budget). */
  openPeople: () => void;
}

export const ShellContext = createContext<BudgetShellState | null>(null);

export function useBudgetShell(): BudgetShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useBudgetShell must be used inside the budget shell');
  return ctx;
}
