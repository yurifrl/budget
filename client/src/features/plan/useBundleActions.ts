/**
 * Plan-screen bundle behaviour (docs/category-bundles-design.md): per-device
 * expand state (core/storage), and the drop / create / join / leave / ungroup
 * actions. Move math lives in domain/bundleDrop.ts (pure, tested); this hook
 * only sequences the mutations: reorder first (contiguous sort orders), then
 * the bundle op, because the server clears bundle_id on cross-group moves.
 */
import { useCallback, useEffect, useState } from 'react';

import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';

import {
  useCreateBundleMutation,
  useDeleteBundleMutation,
  useMoveCategoryMutation,
  useRenameBundleMutation,
  useSetCategoriesBundleMutation,
} from '@/budget/data/api';
import { planCreate, planDrop, planJoin, type DropPlan, type DropTarget } from '@/domain/bundleDrop';
import type { Budget } from '@/domain/types';

/** KVStore key: map of bundle id → expanded (collapsed by default, per device). */
export const EXPANDED_BUNDLES_KEY = 'budget.plan.expandedBundles';
/** Name given to a bundle created by dropping rows; its name field opens focused. */
export const DEFAULT_BUNDLE_NAME = 'New bundle';

export function useBundleActions(budget: Budget | undefined, budgetId: string | null | undefined) {
  const storage = useService(Tokens.Storage);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** Bundle whose name field is open (just created / "Rename"). */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [moveCategory] = useMoveCategoryMutation();
  const [createBundle] = useCreateBundleMutation();
  const [renameBundle] = useRenameBundleMutation();
  const [deleteBundle] = useDeleteBundleMutation();
  const [setCategoriesBundle] = useSetCategoriesBundleMutation();

  useEffect(() => {
    let alive = true;
    void storage.get<Record<string, boolean>>(EXPANDED_BUNDLES_KEY, {}).then((v) => {
      if (alive) setExpanded(v ?? {});
    });
    return () => {
      alive = false;
    };
  }, [storage]);

  const setOpen = useCallback(
    (bundleId: string, open: boolean) => {
      setExpanded((prev) => {
        const next = { ...prev, [bundleId]: open };
        void storage.set(EXPANDED_BUNDLES_KEY, next);
        return next;
      });
    },
    [storage],
  );
  const toggle = useCallback((bundleId: string) => setOpen(bundleId, !expanded[bundleId]), [expanded, setOpen]);

  /** Run a planned reorder, then its bundle op. `name` set → create with it; unset → default name + open the name field. */
  const run = async (plan: DropPlan, name?: string) => {
    if (!budget || !budgetId) return;
    try {
      if (plan.moves.length) await moveCategory({ budgetId, moves: plan.moves }).unwrap();
      const op = plan.bundleOp;
      if (op.kind === 'leave')
        await setCategoriesBundle({
          budgetId,
          categoryIds: op.categoryIds,
          bundleId: null,
        }).unwrap();
      else if (op.kind === 'join') {
        await setCategoriesBundle({
          budgetId,
          categoryIds: op.categoryIds,
          bundleId: op.bundleId,
        }).unwrap();
        setOpen(op.bundleId, true);
      } else if (op.kind === 'create') {
        const made = await createBundle({
          budgetId,
          groupId: op.groupId,
          name: name ?? DEFAULT_BUNDLE_NAME,
          categoryIds: op.categoryIds,
        }).unwrap();
        setOpen(made.id, true);
        if (name === undefined) setRenamingId(made.id);
      }
    } catch {
      // The query layer surfaces the error; a failed step leaves the model as-is.
    }
  };

  const cats = budget?.categories ?? [];
  return {
    expanded,
    toggle,
    setOpen,
    renamingId,
    setRenamingId,
    drop: (dragId: string, target: DropTarget) => run(planDrop(cats, dragId, target)),
    /** Bundle ≥ 2 categories (any groups): they gather in the first one's group. */
    createFrom: (ids: readonly string[], name?: string) => {
      const first = cats.find((c) => ids.includes(c.id));
      if (first) void run(planCreate(cats, ids, first.groupId), name);
    },
    /** `extra`: categories created a moment ago that the cached model doesn't have yet. */
    join: (ids: readonly string[], bundleId: string, extra: { id: string; groupId: string }[] = []) =>
      run(planJoin([...cats, ...extra], ids, bundleId)),
    leave: (ids: readonly string[]) => {
      if (budgetId)
        void setCategoriesBundle({
          budgetId,
          categoryIds: [...ids],
          bundleId: null,
        });
    },
    ungroup: (bundleId: string) => {
      if (budgetId) void deleteBundle({ budgetId, bundleId });
    },
    rename: (bundleId: string, name: string) => {
      if (budgetId) void renameBundle({ budgetId, bundleId, name });
    },
  };
}

export type BundleActions = ReturnType<typeof useBundleActions>;
