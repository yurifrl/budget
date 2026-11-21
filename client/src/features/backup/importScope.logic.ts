/**
 * Import scope (view logic, pure): which parts of a picked backup the user
 * restores. Plan = groups, categories, assignments; Register = accounts and
 * transactions. Dependencies (mirrors the API, see api/src/budget/domain/restore-scope.ts):
 *  - Plan only keeps the register; its categories are re-linked by group+name.
 *  - Register only keeps the plan; transaction categories are matched by group+name.
 */
import type { TransferPayload } from './transfer/payload';
import type { BackupSection } from './transfer/transfer';

export type { BackupSection };

export const SECTION_LABELS: Record<BackupSection, string> = { plan: 'Plan', register: 'Register' };

const SECTION_TABLES: Record<BackupSection, [keyof TransferPayload, string][]> = {
  plan: [
    ['groups', 'group'],
    ['categories', 'category'],
    ['assignments', 'assignment'],
  ],
  register: [
    ['accounts', 'account'],
    ['transactions', 'transaction'],
  ],
};

export function plural(n: number, noun: string): string {
  if (n === 1) return `${n} ${noun}`;
  return `${n} ${noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`}`;
}

/** "3 groups, 12 categories, 40 assignments" for one section of the payload. */
export function sectionCountsText(payload: TransferPayload, section: BackupSection): string {
  return SECTION_TABLES[section].map(([key, noun]) => plural(payload[key].length, noun)).join(', ');
}

/** Sections in canonical order from a set of picked ones. */
export function orderSections(sections: Iterable<BackupSection>): BackupSection[] {
  const set = new Set(sections);
  return (['plan', 'register'] as const).filter((s) => set.has(s));
}

/** Toggle one section in a selection, limited to what the backup contains. */
export function toggleSection(
  selected: readonly BackupSection[],
  section: BackupSection,
  available: readonly BackupSection[],
): BackupSection[] {
  if (!available.includes(section)) return orderSections(selected);
  return orderSections(selected.includes(section) ? selected.filter((s) => s !== section) : [...selected, section]);
}

/** `sections` for the restore call: undefined (= everything, the old contract) when both are chosen. */
export function wireSections(selected: readonly BackupSection[]): BackupSection[] | undefined {
  const ordered = orderSections(selected);
  return ordered.length === 2 ? undefined : ordered;
}

/**
 * Drop what the chosen sections do not use. A register-only payload keeps its
 * groups/categories: they only name the budget categories to match against.
 */
export function scopedPayload(payload: TransferPayload, selected: readonly BackupSection[]): TransferPayload {
  const plan = selected.includes('plan');
  const register = selected.includes('register');
  return {
    groups: payload.groups,
    categories: payload.categories,
    accounts: register ? payload.accounts : [],
    transactions: register ? payload.transactions : [],
    assignments: plan ? payload.assignments : [],
  };
}

/** What gets replaced, for the confirmation sheet. */
export function replaceDescription(selected: readonly BackupSection[]): string {
  const plan = selected.includes('plan');
  const register = selected.includes('register');
  if (plan && register) return 'everything currently in it (categories, accounts, payees, transactions and assignments)';
  if (plan) return 'its categories, groups and assignments';
  return 'its accounts, payees and transactions';
}

/** The dependency note shown with a partial restore; null for a full one. */
export function dependencyNote(selected: readonly BackupSection[]): string | null {
  const plan = selected.includes('plan');
  const register = selected.includes('register');
  if (plan === register) return null;
  return plan
    ? 'Your existing accounts and transactions stay. Their categories are re-linked to the restored categories by group and name; transactions whose category is not in the backup become uncategorized.'
    : 'Your existing categories and assignments stay. Transaction categories are matched to them by group and name; transactions whose category is not found become uncategorized.';
}

/** Register-only: how many register rows name a category the budget does not have. */
export function countUnmatchedCategories(
  payload: TransferPayload,
  existing: readonly { group: string; name: string }[],
): number {
  const key = (g: string, n: string) => `${g.trim().toLowerCase()}\u0000${n.trim().toLowerCase()}`;
  const have = new Set(existing.map((c) => key(c.group, c.name)));
  return payload.transactions.filter((t) => {
    if (t.categoryIndex === null) return false;
    const c = payload.categories[t.categoryIndex];
    return !have.has(key(payload.groups[c.groupIndex] ?? '', c.name));
  }).length;
}
