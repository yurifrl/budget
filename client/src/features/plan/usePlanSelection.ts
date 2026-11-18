/** YNAB parity (syscd-app-42c): Plan-grid row multi-select and hover tracking. */
import { useEffect, useState } from 'react';

import { toggleChecked } from '@/domain/planSelection';
import type { MonthKey } from '@/domain/types';

export function usePlanSelection(budgetId: string | null, month: MonthKey) {
  const [checkedRows, setCheckedRows] = useState<Set<string>>(new Set());
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  /** Selection is per grid view — a budget or month switch starts clean. */
  useEffect(() => {
    setCheckedRows(new Set());
    setHoveredRow(null);
  }, [budgetId, month]);

  return {
    checkedRows,
    hoveredRow,
    setHoveredRow,
    toggleRowChecked: (id: string) => setCheckedRows((prev) => toggleChecked(prev, id)),
    clearChecked: () => setCheckedRows(new Set()),
  };
}

export type PlanSelection = ReturnType<typeof usePlanSelection>;
