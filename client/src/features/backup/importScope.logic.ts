/**
 * Import scope (view logic, pure): which parts of a picked backup the user
 * restores. Plan = groups, categories, assignments; Register = accounts and
 * transactions. Dependencies (mirrors the API, see api/src/budget/domain/restore-scope.ts):
 *  - Plan only keeps the register; its categories are re-linked by group+name.
 *  - Register only keeps the plan; transaction categories are matched by group+name.
 */
import { labels } from '@shared/i18n';

import { t } from './i18n';
import type { TransferPayload } from './transfer/payload';
import type { BackupSection } from './transfer/transfer';

export type { BackupSection };

export const SECTION_LABELS: Record<BackupSection, string> = labels(t, { plan: 'section.plan', register: 'section.register' });

/** The payload tables a count can name. */
export type CountNoun = 'group' | 'category' | 'account' | 'transaction' | 'assignment';

const SECTION_TABLES: Record<BackupSection, [keyof TransferPayload, CountNoun][]> = {
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

/** "3 groups" / "1 group": the count with its noun, in the active language. */
export function countText(count: number, noun: CountNoun): string {
  switch (noun) {
    case 'group':
      return t('count.group', { count });
    case 'category':
      return t('count.category', { count });
    case 'account':
      return t('count.account', { count });
    case 'transaction':
      return t('count.transaction', { count });
    case 'assignment':
      return t('count.assignment', { count });
  }
}

/** "3 groups, 12 categories, 40 assignments" for one section of the payload. */
export function sectionCountsText(payload: TransferPayload, section: BackupSection): string {
  return SECTION_TABLES[section].map(([key, noun]) => countText(payload[key].length, noun)).join(', ');
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

/** What gets replaced, for the confirmation sheet: the whole sentence naming the budget. */
export function replaceSentence(selected: readonly BackupSection[], budgetName: string): string {
  const plan = selected.includes('plan');
  const register = selected.includes('register');
  if (plan && register) return t('confirm.replaceAll', { name: budgetName });
  if (plan) return t('confirm.replacePlan', { name: budgetName });
  return t('confirm.replaceRegister', { name: budgetName });
}

/** The dependency note shown with a partial restore; null for a full one. */
export function dependencyNote(selected: readonly BackupSection[]): string | null {
  const plan = selected.includes('plan');
  const register = selected.includes('register');
  if (plan === register) return null;
  return plan ? t('confirm.noteWithPlan') : t('confirm.noteWithRegister');
}

/** Register-only: how many register rows name a category the budget does not have. */
export function countUnmatchedCategories(
  payload: TransferPayload,
  existing: readonly { group: string; name: string }[],
): number {
  const key = (g: string, n: string) => `${g.trim().toLowerCase()}\u0000${n.trim().toLowerCase()}`;
  const have = new Set(existing.map((c) => key(c.group, c.name)));
  return payload.transactions.filter((tx) => {
    if (tx.categoryIndex === null) return false;
    const c = payload.categories[tx.categoryIndex];
    return !have.has(key(payload.groups[c.groupIndex] ?? '', c.name));
  }).length;
}
