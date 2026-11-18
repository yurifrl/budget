/**
 * Report helpers for category bundles (docs/category-bundles-design.md): the
 * Reflect spend-by-category list shows one row per bundle (the sum of its
 * categories, expandable into them), and a bundle chip filters all of them.
 * Built on `planRows` so grouping stays defined in one place.
 */
import { planRows } from './bundles';
import type { Bundle, Category, Cents } from './types';

export type SpendRow =
  | { kind: 'category'; category: Category; total: Cents }
  | { kind: 'bundle'; bundle: Bundle; total: Cents; children: { category: Category; total: Cents }[] };

/** A Reflect category filter: one category, or a whole bundle. */
export type CategorySelection = { kind: 'category' | 'bundle'; id: string };

/** Positive-spend rows, biggest first; bundle children are sorted the same way. */
export function spendRows(
  categories: readonly Category[],
  bundles: readonly Bundle[],
  totalOf: (category: Category) => Cents,
): SpendRow[] {
  const rows: SpendRow[] = [];
  for (const r of planRows(categories, bundles, (c) => ({ assigned: 0, activity: totalOf(c), available: 0 }))) {
    if (r.kind === 'category') {
      const total = totalOf(r.category);
      if (total > 0) rows.push({ kind: 'category', category: r.category, total });
    } else if (r.sums.activity > 0) {
      const children = r.children
        .map((category) => ({ category, total: totalOf(category) }))
        .filter((x) => x.total > 0)
        .sort((a, b) => b.total - a.total);
      rows.push({ kind: 'bundle', bundle: r.bundle, total: r.sums.activity, children });
    }
  }
  return rows.sort((a, b) => b.total - a.total);
}

/** Category ids a filter covers: the category itself, or every category in the bundle. */
export function selectionCategoryIds(sel: CategorySelection, categories: readonly Category[]): Set<string> {
  return new Set(
    sel.kind === 'category' ? [sel.id] : categories.filter((c) => c.bundleId === sel.id).map((c) => c.id),
  );
}

/** Filter chips: one per bundle (placed at its first child) and one per unbundled category. */
export function filterChips(
  categories: readonly Category[],
  bundles: readonly Bundle[],
): ({ sel: CategorySelection; label: string })[] {
  return planRows(categories, bundles, () => ({ assigned: 0, activity: 0, available: 0 })).map((r) =>
    r.kind === 'category'
      ? { sel: { kind: 'category', id: r.category.id }, label: r.category.name }
      : { sel: { kind: 'bundle', id: r.bundle.id }, label: r.bundle.name },
  );
}
