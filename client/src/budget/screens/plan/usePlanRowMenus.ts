/**
 * Row / group context menus of the Plan grid: which popover is open, the
 * inline rename field, the pending delete confirmation, and what each menu
 * action does (a menu opened on a checked row acts on the whole selection).
 */
import { useState } from 'react';

import {
  useDeleteCategoryMutation,
  useDeleteGroupMutation,
  useRenameCategoryMutation,
  useRenameGroupMutation,
  useSetCategoryHiddenMutation,
  useSetCategoryPersonMutation,
  useSetGroupPersonMutation,
} from '../../data/api';
import { deleteNeedsConfirm, isBatchTarget, menuTargetIds } from '../../domain/planSelection';
import type { Budget } from '../../domain/types';
import type { BudgetMonth } from '../../domain/zeroSum';
import type { PlanSelection } from './usePlanSelection';

export interface RowMenuState {
  id: string;
  kind: 'category' | 'group';
  x: number;
  y: number;
  // xvu: initialRename opens the popover straight into its rename form
  // (right-click trigger) instead of the action list.
  initialRename?: boolean;
}

export function usePlanRowMenus(
  budget: Budget | undefined,
  budgetId: string | null,
  bm: BudgetMonth,
  selection: Pick<PlanSelection, 'checkedRows' | 'clearChecked'>,
) {
  const [renameCategory] = useRenameCategoryMutation();
  const [deleteCategory] = useDeleteCategoryMutation();
  const [setCategoryHidden] = useSetCategoryHiddenMutation();
  const [setCategoryPerson] = useSetCategoryPersonMutation();
  const [setGroupPerson] = useSetGroupPersonMutation();
  const [renameGroup] = useRenameGroupMutation();
  const [deleteGroup] = useDeleteGroupMutation();
  const [rename, setRename] = useState<{ id: string; kind: 'category' | 'group' } | null>(null);
  const [draftName, setDraftName] = useState('');
  // xvu scope B: pending delete of activity-bearing categories awaiting confirmation.
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[] } | null>(null);
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const [bundleMenu, setBundleMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [bundlePop, setBundlePop] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const { checkedRows, clearChecked } = selection;

  const nameOf = (id: string, kind: 'category' | 'group') =>
    kind === 'group'
      ? (budget?.groups.find((g) => g.id === id)?.name ?? '')
      : (budget?.categories.find((c) => c.id === id)?.name ?? '');

  const deleteCategories = (ids: readonly string[]) => {
    if (!budgetId) return;
    for (const cid of ids) void deleteCategory({ budgetId, categoryId: cid });
    if (ids.length > 1) clearChecked();
  };

  return {
    rename,
    draftName,
    setDraftName,
    confirmDelete,
    setConfirmDelete,
    menu,
    setMenu,
    bundleMenu,
    setBundleMenu,
    bundlePop,
    setBundlePop,
    nameOf,

    /** Commit the inline rename field of a category / group row (empty = keep the name). */
    commitRename: () => {
      setRename(null);
      const name = draftName.trim();
      setDraftName('');
      if (!rename || !name || !budgetId) return;
      if (rename.kind === 'category') void renameCategory({ budgetId, categoryId: rename.id, name });
      else void renameGroup({ budgetId, groupId: rename.id, name });
    },

    /** "Assign to…": the group, or the category (the whole selection when it is part of one). */
    assignMenuTo: (m: RowMenuState, userId: string | null) => {
      const { id, kind } = m;
      setMenu(null);
      if (!budgetId) return;
      if (kind === 'group') {
        void setGroupPerson({ budgetId, groupId: id, userId });
        return;
      }
      for (const cid of menuTargetIds(checkedRows, id)) void setCategoryPerson({ budgetId, categoryId: cid, userId });
    },

    /** Phone/tablet "Rename": close the menu and turn the row's name into an input. */
    startInlineRename: (m: RowMenuState) => {
      const { id, kind } = m;
      setMenu(null);
      setRename({ id, kind });
      setDraftName(nameOf(id, kind));
    },

    hideFromMenu: (m: RowMenuState) => {
      setMenu(null);
      if (!budgetId) return;
      const ids = menuTargetIds(checkedRows, m.id);
      for (const cid of ids) void setCategoryHidden({ budgetId, categoryId: cid, hidden: true });
      if (ids.length > 1) clearChecked();
    },

    deleteFromMenu: (m: RowMenuState) => {
      const { id, kind } = m;
      const ids = kind === 'category' && isBatchTarget(checkedRows, id) ? [...checkedRows] : [id];
      // xvu scope B: activity-bearing categories ask confirmation (YNAB parity).
      const hasActivity = kind === 'category' && deleteNeedsConfirm(ids, budget?.categories ?? [], bm);
      setMenu(null);
      if (!budgetId) return;
      if (kind === 'category') {
        if (hasActivity) {
          setConfirmDelete({ ids });
          return;
        }
        deleteCategories(ids);
      } else {
        void deleteGroup({ budgetId, groupId: id });
      }
    },

    /** The desktop popover's rename form (OK / Enter). */
    renameFromMenu: (m: RowMenuState, name: string) => {
      if (!budgetId) return;
      if (m.kind === 'category') void renameCategory({ budgetId, categoryId: m.id, name });
      else void renameGroup({ budgetId, groupId: m.id, name });
    },

    /** "Delete" on the confirmation card. */
    confirmDeleteNow: () => {
      if (!confirmDelete) return;
      const ids = confirmDelete.ids;
      setConfirmDelete(null);
      deleteCategories(ids);
    },
  };
}

export type PlanRowMenus = ReturnType<typeof usePlanRowMenus>;
