/** Per-group collapsed state of the Plan grid, persisted per device (KVStore). */
import { useEffect, useState } from 'react';

import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';

/** KVStore key persisting the per-group collapsed map across reloads. */
const COLLAPSED_KEY = 'budget.plan.collapsedGroups';

export function useCollapsedGroups() {
  const storage = useService(Tokens.Storage);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    void storage.get<Record<string, boolean>>(COLLAPSED_KEY, {}).then((v) => {
      if (alive) setCollapsed(v ?? {});
    });
    return () => {
      alive = false;
    };
  }, [storage]);

  const toggleGroupCollapsed = (groupId: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      void storage.set(COLLAPSED_KEY, next);
      return next;
    });
  };

  /** Open a group for this session only (not persisted): "add category here" on a bundle. */
  const expandGroup = (groupId: string) => setCollapsed((prev) => ({ ...prev, [groupId]: false }));

  return { collapsed, toggleGroupCollapsed, expandGroup };
}

export type CollapsedGroups = ReturnType<typeof useCollapsedGroups>;
