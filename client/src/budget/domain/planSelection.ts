/**
 * Plan-grid row multi-select (YNAB parity, syscd-app-42c): the checked set
 * and which rows a row-menu action applies to. Pure.
 */
import type { Category } from './types';
import { categoryFigures, type BudgetMonth } from './zeroSum';

/** Check / uncheck one row; returns a new set (the input is not mutated). */
export function toggleChecked(checked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(checked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** A menu opened on `id` acts on the whole selection: 2+ rows checked and `id` is one of them. */
export function isBatchTarget(checked: ReadonlySet<string>, id: string): boolean {
  return checked.size > 1 && checked.has(id);
}

/** Rows a menu action on `id` applies to: the whole selection (in check order) or just `id`. */
export function menuTargetIds(checked: ReadonlySet<string>, id: string): string[] {
  return isBatchTarget(checked, id) ? [...checked] : [id];
}

/**
 * xvu scope B: activity-bearing categories ask confirmation before delete
 * (YNAB parity). True when any of `ids` is a known category with non-zero
 * activity in the engine's month; unknown ids never ask.
 */
export function deleteNeedsConfirm(
  ids: readonly string[],
  categories: readonly Pick<Category, 'id'>[],
  bm: BudgetMonth,
): boolean {
  return ids.some((cid) => {
    const c = categories.find((x) => x.id === cid);
    return c ? categoryFigures(bm, c.id).activity !== 0 : false;
  });
}
