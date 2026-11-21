/**
 * Shared item-builder for grouped, searchable category pick lists — one source
 * for the Move Money "To" dropdown, the mobile move-money list and any future
 * endpoint picker. Callers keep their own presentation (portal dropdown vs
 * full-screen rows); this owns filtering, grouping and row identity.
 */

import { categoryLabel } from '@/domain/bundles';
import type { Bundle, Category, CategoryGroup } from '@/domain/types';

import { t } from './text/i18n';

/** Picker search: matches the category name or its bundle name (case-insensitive). */
export function matchesCategoryQuery(
  category: Pick<Category, 'name' | 'bundleId'>,
  bundles: readonly Bundle[],
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  return !q || categoryLabel(category, bundles).toLowerCase().includes(q);
}

export type CategoryPickItem = {
  /** Stable React key (`__selected__` / `__rta__` for the synthetic rows). */
  key: string;
  /** Category id, or null for the Ready-to-Assign row. */
  categoryId: string | null;
  label: string;
  groupTitle?: string;
  checked: boolean;
};

export function buildCategoryPickItems({
  categories,
  groups,
  bundles = [],
  query,
  excludeId,
  selectedId,
  pinSelected = false,
  rta = false,
  excludeHidden = false,
}: {
  categories: Category[];
  groups: CategoryGroup[];
  /** Bundles of the budget: labels read "Bundle › Category" and search matches either part. */
  bundles?: Bundle[];
  /** Free-text search; empty/whitespace shows everything. */
  query: string;
  /** Category id to exclude (the move source can't be its own destination). */
  excludeId: string | null;
  /** Currently picked id — undefined means "nothing picked yet" (no checkmarks). */
  selectedId: string | null | undefined;
  /** Pin the selected category as a checked first row (desktop dropdown). */
  pinSelected?: boolean;
  /** Include the Ready-to-Assign row (checked when selectedId is null). */
  rta?: boolean;
  /** Skip hidden categories (phone-space lists). */
  excludeHidden?: boolean;
}): CategoryPickItem[] {
  const q = query.trim().toLowerCase();
  const rows: CategoryPickItem[] = [];
  const current = selectedId ? (categories.find((c) => c.id === selectedId) ?? null) : null;
  if (pinSelected && current) {
    rows.push({ key: '__selected__', categoryId: current.id, label: categoryLabel(current, bundles), checked: true });
  }
  if (rta) {
    rows.push({ key: '__rta__', categoryId: null, label: t('category.readyToAssign'), checked: selectedId === null });
  }
  for (const g of groups) {
    for (const cat of categories) {
      if (cat.groupId !== g.id) continue;
      if (excludeHidden && cat.hidden) continue;
      if (cat.id === excludeId) continue;
      if (!matchesCategoryQuery(cat, bundles, q)) continue;
      rows.push({
        key: cat.id,
        categoryId: cat.id,
        label: categoryLabel(cat, bundles),
        groupTitle: g.name,
        checked: cat.id === selectedId,
      });
    }
  }
  return rows;
}
