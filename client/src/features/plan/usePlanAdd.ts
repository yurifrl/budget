/** Inline "add category" / "add category group" rows of the Plan grid. */
import { useState } from 'react';

import { useAddCategoryMutation, useAddGroupMutation } from '@/budget/data/api';
import type { Budget, Bundle } from '@/domain/types';
import type { BundleActions } from './useBundleActions';

export function usePlanAdd(
  budget: Budget | undefined,
  budgetId: string | null,
  bundleApi: Pick<BundleActions, 'join' | 'setOpen'>,
  expandGroup: (groupId: string) => void,
) {
  const [addCategory] = useAddCategoryMutation();
  const [addGroup] = useAddGroupMutation();
  const [addCatGroup, setAddCatGroup] = useState<string | null>(null);
  /** "Add category here": the inline add row opens inside this bundle. */
  const [addCatBundle, setAddCatBundle] = useState<string | null>(null);
  // xvu scope C: pill opens the add-group input inline in the toolbar (footer row kept).
  const [addingGroup, setAddingGroup] = useState<'toolbar' | 'footer' | null>(null);

  const cancelAddCategory = () => {
    setAddCatGroup(null);
    setAddCatBundle(null);
  };

  return {
    addCatGroup,
    addCatBundle,
    addingGroup,
    setAddingGroup,
    openAddCategory: (groupId: string) => setAddCatGroup(groupId),
    /** Bundle menu "Add category here": open the bundle and its group, then the add row inside it. */
    openAddCategoryInBundle: (b: Bundle) => {
      bundleApi.setOpen(b.id, true);
      expandGroup(b.groupId);
      setAddCatBundle(b.id);
      setAddCatGroup(b.groupId);
    },
    cancelAddCategory,
    commitAddCategory: (groupId: string, name: string) => {
      if (!budget || !budgetId) return;
      const intoBundle = addCatBundle;
      cancelAddCategory();
      void addCategory({
        budgetId,
        groupId,
        name,
        sortOrder: budget.categories.filter((x) => x.groupId === groupId).length,
      })
        .unwrap()
        .then((made) => {
          if (intoBundle) void bundleApi.join([made.id], intoBundle, [{ id: made.id, groupId }]);
        })
        .catch(() => undefined);
    },
    commitAddGroup: (name: string) => {
      if (!budget || !budgetId) return;
      setAddingGroup(null);
      void addGroup({ budgetId, name, sortOrder: budget.groups.length });
    },
  };
}

export type PlanAdd = ReturnType<typeof usePlanAdd>;
