/**
 * Category bundles (docs/category-bundles-design.md): display-only roll-ups of
 * categories inside one category group. Pure helpers shared by Plan, pickers
 * and reports — the engine never sees bundles.
 */
import type { Bundle, Category, Cents } from './types';

export interface BundleFigures {
  assigned: Cents;
  activity: Cents;
  available: Cents;
}

export type PlanRow<C extends Pick<Category, 'id' | 'bundleId'> = Category> =
  | { kind: 'category'; category: C }
  | { kind: 'bundle'; bundle: Bundle; children: C[]; sums: BundleFigures };

/**
 * Turn one group's categories (already in sort order) into display rows. A
 * bundle is placed at its first child's slot and gathers all its children
 * there (contiguous, sort order preserved). `figures` supplies the per-category
 * month numbers — feed it the engine's unified figures, e.g.
 * `(c) => categoryFigures(budgetMonth(budget, m), c.id)`.
 * A category pointing at an unknown bundle renders as a plain category.
 */
export function planRows<C extends Pick<Category, 'id' | 'bundleId'>>(
  groupCategories: readonly C[],
  bundles: readonly Bundle[],
  figures: (category: C) => BundleFigures,
): PlanRow<C>[] {
  const byId = new Map(bundles.map((b) => [b.id, b]));
  const children = new Map<string, C[]>();
  for (const c of groupCategories) {
    if (c.bundleId && byId.has(c.bundleId)) children.set(c.bundleId, [...(children.get(c.bundleId) ?? []), c]);
  }
  const rows: PlanRow<C>[] = [];
  const placed = new Set<string>();
  for (const c of groupCategories) {
    const bundle = c.bundleId ? byId.get(c.bundleId) : undefined;
    if (!bundle) {
      rows.push({ kind: 'category', category: c });
      continue;
    }
    if (placed.has(bundle.id)) continue;
    placed.add(bundle.id);
    const kids = children.get(bundle.id) ?? [];
    const sums = kids.reduce<BundleFigures>(
      (acc, k) => {
        const f = figures(k);
        return { assigned: acc.assigned + f.assigned, activity: acc.activity + f.activity, available: acc.available + f.available };
      },
      { assigned: 0, activity: 0, available: 0 },
    );
    rows.push({ kind: 'bundle', bundle, children: kids, sums });
  }
  return rows;
}

/** "Medicines › Dipirona" for a bundled category, the plain name otherwise. */
export function categoryLabel(category: Pick<Category, 'name' | 'bundleId'>, bundles: readonly Bundle[]): string {
  const bundle = category.bundleId ? bundles.find((b) => b.id === category.bundleId) : undefined;
  return bundle ? `${bundle.name} › ${category.name}` : category.name;
}

export type DropIntent = 'before' | 'after' | 'bundle';

/** Pointer y over a row: outer 25% of each edge reorders, the middle 50% bundles. */
export function dropIntent(y: number, rect: { top: number; bottom: number }): DropIntent {
  const h = rect.bottom - rect.top;
  if (h <= 0) return 'bundle';
  const rel = (y - rect.top) / h;
  if (rel < 0.25) return 'before';
  if (rel > 0.75) return 'after';
  return 'bundle';
}
