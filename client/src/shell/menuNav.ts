/**
 * The settings menu's pane navigation context: what pane content (the
 * settings feature) may use of the menu host (shell/SettingsMenu).
 */
import { createContext, useContext, type ReactNode } from 'react';

/** A host-rendered pane on the menu's pane stack. */
export interface MenuPane {
  id: string;
  title: string;
  content: ReactNode;
}

/** Pane navigation handed to pane content via useMenuNav(). */
export interface MenuNav {
  /** Push a pane (by id) onto the stack. */
  open: (id: string) => void;
  /**
   * Push the per-budget pane onto the stack (Open Budget rows): carries the
   * target id in one call so the pane reads it without extra plumbing.
   */
  openBudget: (id: string) => void;
  /** Budget the per-budget pane operates on (set by openBudget). */
  editingBudgetId: string | null;
  /** Pop the stack (no-op at the root pane). */
  back: () => void;
  /** Close the whole menu. */
  close: () => void;
}

export const MenuNavContext = createContext<MenuNav | null>(null);

/** Pane-content navigation hook (menu rows use it to push sibling panes). */
export function useMenuNav(): MenuNav {
  const nav = useContext(MenuNavContext);
  if (!nav) throw new Error('useMenuNav must be used inside the settings menu');
  return nav;
}
