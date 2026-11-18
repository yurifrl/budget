/** The Plan grid's "hidden categories" section: what it lists, its open state and Restore. */
import { useMemo, useState } from 'react';

import { useAppSelector } from '@/state/hooks';

import { useSetCategoryHiddenMutation } from '@/budget/data/api';
import type { Budget } from '@/domain/types';
import { sumFigures, type BudgetMonth } from '@/domain/zeroSum';
import { selectShowHiddenCategories } from '@/state/ui';

export function useHiddenSection(budget: Budget | undefined, budgetId: string | null, bm: BudgetMonth) {
  const [setCategoryHidden] = useSetCategoryHiddenMutation();
  const showHiddenRow = useAppSelector((s) => selectShowHiddenCategories(s));
  const [hiddenOpen, setHiddenOpen] = useState(true);
  const hiddenCats = useMemo(() => (budget ? budget.categories.filter((c) => c.hidden) : []), [budget]);
  const hiddenTotal = useMemo(
    () => sumFigures(bm, hiddenCats.map((c) => c.id)).available,
    [hiddenCats, bm],
  );
  return {
    /** Views menu toggle: whether the section shows at all. */
    showHiddenRow,
    hiddenOpen,
    toggleHidden: () => setHiddenOpen((o) => !o),
    hiddenCats,
    hiddenTotal,
    restore: (categoryId: string) => {
      if (budgetId) void setCategoryHidden({ budgetId, categoryId, hidden: false });
    },
  };
}

export type HiddenSection = ReturnType<typeof useHiddenSection>;
