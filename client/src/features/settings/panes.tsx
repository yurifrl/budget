/**
 * Budget settings panes for the settings menu (SHARED CONTRACT with
 * shell/SettingsMenu): the menu owns the surface (an RN Modal
 * portal — nothing can paint over it) and the pane stack; this directory owns
 * the Budget panes rendered inside it (one file per pane, assembled here).
 * ONE menu, one palette — the panes reuse
 * the switcher's colors (#161a24 bg, #333c50 border, #eef1f7 text, #211d3b
 * active) instead of a second floating panel (the deleted SettingsPanel).
 *
 * Panes: root (SETTINGS) → open / new / people (sharing) / settings (plan name + format prefs
 * with live preview) / flags (6 fixed colors, editable labels — YNAB parity)
 * / display / shortcuts (web only) / account. Settings of the ACTIVE budget
 * are budgetUi actions, persisted per budget by state/budgetSettings; the
 * Hide Amounts mask is session-scoped by design (task 3.4).
 */
import type { MenuPane } from '@/shell/menuNav';

import { AccountPane } from './AccountPane';
import { BudgetEditMenuPane, BudgetEditSettingsPane } from './BudgetEditPanes';
import { DisplayPane } from './DisplayPane';
import { FlagsPane } from './FlagsPane';
import { FreshStartPane } from './FreshStartPane';
import { NewBudgetPane } from './NewBudgetPane';
import { OpenBudgetPane } from './OpenBudgetPane';
import { PeopleRoute } from './PeopleRoute';
import { PlanSettingsPane } from './PlanSettingsPane';
import { SettingsRootPane } from './SettingsRootPane';
import { ShortcutsPane } from './ShortcutsPane';

/** The gear's pane set — one pane per former Settings-panel view. */
export function budgetMenuPanes(budgetId: string | null): MenuPane[] {
  return [
    { id: 'settings-root', title: 'SETTINGS', content: <SettingsRootPane /> },
    { id: 'open', title: 'OPEN BUDGET', content: <OpenBudgetPane /> },
    { id: 'budget-edit', title: 'EDIT BUDGET', content: <BudgetEditMenuPane /> },
    { id: 'new', title: 'NEW BUDGET', content: <NewBudgetPane /> },
    { id: 'people', title: 'PEOPLE', content: <PeopleRoute budgetId={budgetId} /> },
    { id: 'fresh-start', title: 'FRESH START', content: <FreshStartPane /> },
    { id: 'settings', title: 'PLAN SETTINGS', content: <PlanSettingsPane budgetId={budgetId} /> },
    {
      id: 'budget-settings',
      // Per-budget copy of Plan Settings for the EDIT BUDGET menu: same pane
      // component, but bound to the menu's target budget (not the active one).
      title: 'PLAN SETTINGS',
      content: <BudgetEditSettingsPane />,
    },
    { id: 'flags', title: 'EDIT FLAGS', content: <FlagsPane /> },
    { id: 'display', title: 'DISPLAY OPTIONS', content: <DisplayPane /> },
    { id: 'shortcuts', title: 'KEYBOARD SHORTCUTS', content: <ShortcutsPane /> },
    { id: 'account', title: 'ACCOUNT SETTINGS', content: <AccountPane /> },
  ];
}
