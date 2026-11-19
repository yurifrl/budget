/**
 * Restore scope rules (pure): which sections of a backup a restore replaces and
 * how a register-only restore maps backup categories onto the budget's own.
 *
 * Dependencies between sections (documented choice):
 *  - plan only: the register stays; its category links are re-pointed to the
 *    restored categories by (group name, category name), case-insensitive.
 *    Links with no match become uncategorized.
 *  - register only: the plan stays; each transaction's category (given by the
 *    payload's categories/groups) is matched to the budget's existing categories
 *    by (group name, category name). No match: the transaction is uncategorized.
 *  - both (default): everything is replaced, links come from payload indexes.
 */
import type { RestoreSection } from '@shared/contracts/budget/schemas';

export interface RestoreScope {
  plan: boolean;
  register: boolean;
}

export function restoreScope(sections: readonly RestoreSection[] | undefined): RestoreScope {
  if (!sections || sections.length === 0) return { plan: true, register: true };
  return { plan: sections.includes('plan'), register: sections.includes('register') };
}

const key = (group: string, name: string): string => `${group.trim().toLowerCase()}\u0000${name.trim().toLowerCase()}`;

/**
 * For each payload category (index-aligned) the id of the existing category with
 * the same group+name, or null. First match wins when names repeat.
 */
export function matchCategoryIds(
  payloadGroups: readonly string[],
  payloadCategories: ReadonlyArray<{ groupIndex: number; name: string }>,
  existing: ReadonlyArray<{ id: string; group_name: string; name: string }>,
): (string | null)[] {
  const byKey = new Map<string, string>();
  for (const c of existing) {
    const k = key(c.group_name, c.name);
    if (!byKey.has(k)) byKey.set(k, c.id);
  }
  return payloadCategories.map((c) => byKey.get(key(payloadGroups[c.groupIndex] ?? '', c.name)) ?? null);
}
