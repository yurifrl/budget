/**
 * Pure payee-domain functions: rename-rule matching, rule application, and
 * categorization inference. No IO — server routes (and transaction creation)
 * supply data and persist results.
 */

/**
 * The match types the released clients know (the single-rule endpoint and the
 * `rename_match_type` field of a payee row only ever carry these two).
 */
export type MatchType = 'is' | 'contains';
export type CategorizationMode = 'auto' | 'fixed' | 'never';

/** Every match type a renaming rule can have: the released two plus "starts with" and "ends with". */
export type RuleMatchType = MatchType | 'starts_with' | 'ends_with';

/** Runtime value lists shared by zod validation and client pickers. */
export const matchTypes: readonly MatchType[] = ['contains', 'is'];
export const ruleMatchTypes: readonly RuleMatchType[] = ['is', 'starts_with', 'ends_with', 'contains'];
export const categorizationModes: readonly CategorizationMode[] = ['auto', 'fixed', 'never'];

/** Dropdown labels for matchTypes (Manage Payees renaming section). */
export const matchTypeLabels: Record<MatchType, string> = { contains: 'Contains', is: 'Is' };
export const ruleMatchTypeLabels: Record<RuleMatchType, string> = {
  is: 'Is',
  starts_with: 'Starts with',
  ends_with: 'Ends with',
  contains: 'Contains',
};

/**
 * One renaming rule, owned by the payee whose name is the target: "imported
 * text that <is | contains | starts with | ends with> X is renamed to this
 * payee". A matching rule ASSIGNS the transaction to that payee; the imported
 * text is kept as the row's import name, never spliced into the payee name.
 * A payee holds any number of rules.
 */
export interface RenameRule {
  /** Statement text the rule matches. */
  condition: string;
  match_type: RuleMatchType;
  /** The owning payee's name (rename target). */
  replacement: string;
}

/**
 * The form a rule's pattern and a text are compared in: surrounding and
 * repeated whitespace collapsed, lower case. Accents are NOT folded ("pão" and
 * "pao" are different texts), as before.
 */
export function normalizeRuleText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** How specific a rule is: lower first. `is` < `starts with` = `ends with` < `contains`. */
function specificity(type: RuleMatchType): number {
  return type === 'is' ? 0 : type === 'contains' ? 2 : 1;
}

function fires(type: RuleMatchType, needle: string, hay: string): boolean {
  if (needle === '') return false;
  switch (type) {
    case 'is':
      return hay === needle;
    case 'starts_with':
      return hay.startsWith(needle);
    case 'ends_with':
      return hay.endsWith(needle);
    case 'contains':
      return hay.includes(needle);
  }
}

/** Does one rule fire for this raw payee name? Case-insensitive, whitespace-insensitive. */
export function matchRule(rule: RenameRule, name: string): boolean {
  return fires(rule.match_type, normalizeRuleText(rule.condition), normalizeRuleText(name));
}

/**
 * The rule that decides a text, or null. When several rules match (of one payee
 * or of several), the most specific wins: `is`, then `starts with` / `ends
 * with`, then `contains`; then the longest pattern; then the earliest in
 * `rules`, so callers list the oldest rule first. Deterministic whatever the
 * rules' number.
 */
export function findRenameRule<R extends RenameRule>(rules: readonly R[], name: string): R | null {
  const hay = normalizeRuleText(name);
  let best: { rule: R; rank: number; length: number } | null = null;
  for (const rule of rules) {
    const needle = normalizeRuleText(rule.condition);
    if (!fires(rule.match_type, needle, hay)) continue;
    const rank = specificity(rule.match_type);
    if (best === null || rank < best.rank || (rank === best.rank && needle.length > best.length)) {
      best = { rule, rank, length: needle.length };
    }
  }
  return best?.rule ?? null;
}

/**
 * The payee name a text resolves to: the winning rule's payee (see
 * `findRenameRule`), whole; the name unchanged when no rule matches.
 */
export function applyRules(rules: readonly RenameRule[], name: string): string {
  return findRenameRule(rules, name)?.replacement ?? name;
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
