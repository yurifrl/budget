/**
 * The Plan grid's rows: one section per category group, holding the visible
 * categories, bundle roll-ups (with their children when expanded) and the
 * inline "add category" sentinel. Pure: the screen feeds it the budget, the
 * engine's month and its view state.
 */
import { bundleRowKey } from './bundleDrop';
import { planRows, type PlanRow } from './bundles';
import { activityFor, categoriesForPerson, PERSON_ALL, type ActivityMap, type PersonFilter } from './people';
import { matchesPlanFilter, type PlanFilterKey } from './planFilter';
import type { Budget, Category, CategoryGroup } from './types';
import { categoryFigures, type BudgetMonth } from './zeroSum';

/** SectionList sentinel row for the inline "add category" input. */
export const ADD_SENTINEL = '__add_category__';

/** A bundle roll-up row (same shape as the screen's `BundleItem`). */
export type PlanBundleRow = Extract<PlanRow, { kind: 'bundle' }>;

/** One plan SectionList section: a group and its visible rows (string = ADD_SENTINEL). */
export type PlanItem = Category | PlanBundleRow | typeof ADD_SENTINEL;
export interface PlanSection {
  group: CategoryGroup;
  data: readonly PlanItem[];
  hasCats: boolean;
}

const isBundleRow = (x: PlanItem): x is PlanBundleRow =>
  typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === 'bundle';

export interface PlanSectionsInput {
  budget: Budget;
  bm: BudgetMonth;
  filter: PlanFilterKey;
  person: PersonFilter;
  /** Per-person activity (null = household). */
  activity: ActivityMap | null;
  /** Group id -> collapsed. */
  collapsed: Readonly<Record<string, boolean>>;
  /** Bundle id -> expanded. */
  expandedBundles: Readonly<Record<string, boolean>>;
  /** Group whose inline "add category" row is open. */
  addCatGroup: string | null;
  /** "Add category here": the inline add row opens inside this bundle. */
  addCatBundle: string | null;
}

export function buildPlanSections({
  budget,
  bm,
  filter,
  person,
  activity,
  collapsed,
  expandedBundles,
  addCatGroup,
  addCatBundle,
}: PlanSectionsInput): PlanSection[] {
  return budget.groups
    .map((g): PlanSection => {
      const cats = categoriesForPerson(
        budget.categories.filter((c) => c.groupId === g.id && !c.hidden && matchesPlanFilter(c, bm, filter)),
        person,
      );
      if (collapsed[g.id] && addCatGroup !== g.id)
        return { group: g, data: [] as PlanItem[], hasCats: cats.length > 0 };
      const items: PlanItem[] = [];
      for (const row of planRows(cats, budget.bundles, (c) => ({
        assigned: categoryFigures(bm, c.id).assigned,
        activity: activityFor(bm, c.id, activity),
        available: categoryFigures(bm, c.id).available,
      }))) {
        if (row.kind === 'category') items.push(row.category);
        else {
          items.push(row);
          if (expandedBundles[row.bundle.id]) items.push(...row.children);
          if (addCatGroup === g.id && addCatBundle === row.bundle.id) items.push(ADD_SENTINEL);
        }
      }
      if (addCatGroup === g.id) {
        if (!addCatBundle) items.push(ADD_SENTINEL);
        return { group: g, data: items, hasCats: true };
      }
      return { group: g, data: items, hasCats: cats.length > 0 };
    })
    // YNAB parity: an inline-added empty group stays visible on the "all"
    // filter (ready for ＋ add-category), and a collapsed group keeps its
    // header row whenever it still holds visible categories.
    .filter(
      (s) =>
        s.data.length > 0 ||
        (filter === 'all' && person === PERSON_ALL && (s.hasCats || !collapsed[s.group.id])) ||
        // A collapsed group keeps its header while it still holds categories visible to the person.
        (person !== PERSON_ALL && s.hasCats),
    );
}

/** SectionList key of one row: the sentinel itself, `bundle:<id>`, or the category id. */
export function planItemKey(item: PlanItem): string {
  return typeof item === 'string' ? item : isBundleRow(item) ? bundleRowKey(item.bundle.id) : item.id;
}

/** Drop-target row keys in display order (category ids and `bundle:<id>`). */
export function dropRowOrder(sections: readonly PlanSection[]): string[] {
  return sections.flatMap((s) =>
    s.data.flatMap((row) => (typeof row === 'string' ? [] : [isBundleRow(row) ? bundleRowKey(row.bundle.id) : row.id])),
  );
}
