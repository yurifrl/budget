/** What the Plan screen hands to its parts (features/plan/). */
import type { ComponentRef, RefObject } from 'react';
import type { Pressable, View } from 'react-native';

import type { Budget, MonthKey } from '@/domain/types';
import type { BudgetMonth } from '@/domain/zeroSum';
import type { PersonFilterModel } from '@/features/people';
import type { BudgetShellState } from '@/shell/context';
import type { BundleActions } from './useBundleActions';
import type { CollapsedGroups } from './useCollapsedGroups';
import type { PlanAdd } from './usePlanAdd';
import type { PlanDrag } from './usePlanDrag';
import type { PlanNumpad } from './usePlanNumpad';
import type { PlanOverlaysState } from './usePlanOverlays';
import type { PlanRowMenus } from './usePlanRowMenus';
import type { PlanSelection } from './usePlanSelection';
import type { PlanUndo } from './usePlanUndo';

/** Grid rows by drop key (category id / `bundle:<id>`), for measuring. */
export type RowRefs = RefObject<Map<string, ComponentRef<typeof Pressable>>>;
// pjtv: per-row AVAILABLE-pill wrapper refs — the popover anchors via
// measureInWindow because synthetic/CDP presses report pageX≈0.
export type PillRefs = RefObject<Map<string, ComponentRef<typeof View>>>;

/**
 * Menus are absolutely positioned inside the screen's root, whose offset
 * parent is the budget content shell — pageX alone mis-anchors at desktop
 * width. Converts a page point into screen-root space at press time.
 */
export type AnchorAt = (pageX: number, pageY: number, cb: (x: number, y: number) => void) => void;

/** The loaded Plan grid: data, view flags and the screen's state hooks. */
export interface PlanGrid {
  budget: Budget;
  budgetId: string;
  /** The engine's figures for `month`. */
  bm: BudgetMonth;
  month: MonthKey;
  shell: BudgetShellState;
  byPerson: PersonFilterModel;
  /** Category open in the inspector (desktop/tablet). */
  selectedId: string | null;
  // YNAB mobile parity: ASSIGNED shows on every form factor (phone rows were
  // Available-only); ACTIVITY stays desktop/tablet where there's width.
  showActivity: boolean;
  // Phone has no room for a third column: with a person selected the middle
  // column becomes ACTIVITY (the only figure the person filter changes) and
  // reverts to ASSIGNED for Everyone. Row tap still opens the assign numpad.
  phoneActivity: boolean;
  showProgressBars: boolean;
  selection: PlanSelection;
  drag: PlanDrag;
  menus: PlanRowMenus;
  add: PlanAdd;
  numpad: PlanNumpad;
  overlays: PlanOverlaysState;
  undo: PlanUndo;
  groups: CollapsedGroups;
  bundleApi: BundleActions;
  anchorAt: AnchorAt;
  rowRefs: RowRefs;
  pillRefs: PillRefs;
}
