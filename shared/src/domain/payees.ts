/**
 * Pure payee-domain functions: rename-rule matching, rule application, and
 * categorization inference. No IO — server routes (and transaction creation)
 * supply data and persist results.
 */

export type MatchType = 'is' | 'contains';
export type CategorizationMode = 'auto' | 'fixed' | 'never';

/** Runtime value lists shared by zod validation and client pickers. */
export const matchTypes: readonly MatchType[] = ['contains', 'is'];
export const categorizationModes: readonly CategorizationMode[] = ['auto', 'fixed', 'never'];

/** Dropdown labels for matchTypes (Manage Payees renaming section). */
export const matchTypeLabels: Record<MatchType, string> = { contains: 'Contains', is: 'Is' };

/**
 * One renaming rule, owned by the payee whose name is the target: imported
 * statement text matching the condition resolves to (or replaces into) that
 * payee. One rule per payee, stored on the payees row.
 */
export interface RenameRule {
  /** Statement text the rule matches. */
  condition: string;
  match_type: MatchType;
  /** The owning payee's name (rename target). */
  replacement: string;
}

/** Does one rule fire for this raw payee name? */
export function matchRule(rule: RenameRule, name: string): boolean {
  const needle = rule.condition.toLowerCase();
  if (needle === '') return false;
  const hay = name.toLowerCase();
  return rule.match_type === 'is' ? hay === needle : hay.includes(needle);
}

/**
 * Apply the first matching rule (rules are ordered by caller); otherwise the
 * name unchanged. `contains` rewrites every occurrence of the condition;
 * `is` swaps the whole name.
 */
export function applyRules(rules: RenameRule[], name: string): string {
  for (const rule of rules) {
    if (!matchRule(rule, name)) continue;
    if (rule.match_type === 'is') return rule.replacement;
    const replaced = name.toLowerCase().split(rule.condition.toLowerCase()).join(rule.replacement);
    if (replaced.trim()) return replaced.trim();
  }
  return name;
}

export interface PayeeCategorization {
  /** Payee categorization mode governing the decision below. */
  categorization_mode: CategorizationMode;
  /** Category the payee falls back to (used verbatim by 'fixed'). */
  default_category_id: string | null;
}

/** One historical transaction row relevant to categorization inference. */
export interface CategorizationHistoryRow {
  /** Category used by the past transaction; null rows are ignored. */
  category_id: string | null;
  /** Transaction date (YYYY-MM-DD); later dates win ties. */
  date: string;
}

/**
 * The category a new transaction with this payee would be preselected with:
 * - 'never'  -> none
 * - 'fixed'  -> always the payee's default category
 * - 'auto'   -> the most-used past category, ties broken by most recent use;
 *   null when the payee has no categorized history — nothing is invented.
 */
export function suggestCategory(
  payee: PayeeCategorization,
  historyRows: readonly CategorizationHistoryRow[],
  mode: CategorizationMode,
): string | null {
  if (mode === 'never') return null;
  if (mode === 'fixed') return payee.default_category_id;

  const stats = new Map<string, { count: number; lastDate: string }>();
  for (const row of historyRows) {
    if (row.category_id === null) continue;
    const stat = stats.get(row.category_id);
    if (!stat) stats.set(row.category_id, { count: 1, lastDate: row.date });
    else {
      stat.count += 1;
      if (row.date > stat.lastDate) stat.lastDate = row.date;
    }
  }

  let best: { category_id: string; count: number; lastDate: string } | null = null;
  for (const [category_id, { count, lastDate }] of stats) {
    if (
      best == null ||
      count > best.count ||
      (count === best.count &&
        (lastDate > best.lastDate || (lastDate === best.lastDate && category_id < best.category_id)))
    ) {
      best = { category_id, count, lastDate };
    }
  }
  return best?.category_id ?? null;
}

/**
 * Majority category among the payee's last transactions (the caller supplies
 * the most recent few — the payee admin list uses the last 3): a category
 * holding more than half of the categorized rows wins; a split (all
 * disagreeing) invents nothing and returns null. Null category rows carry no
 * signal. Pure — the server's SQL assembles the same input.
 */
export function inferDefaultCategory(
  rows: readonly { category_id: string | null }[],
): string | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    if (row.category_id === null) continue;
    counts.set(row.category_id, (counts.get(row.category_id) ?? 0) + 1);
    total += 1;
  }
  for (const [category_id, count] of counts) {
    if (count * 2 > total) return category_id;
  }
  return null;
}
