/**
 * What the renaming rules did BEFORE a matching rule assigned its payee (up to
 * 6027e7c): a `contains` rule rewrote only the matching part of the imported
 * text and kept the rest ("PIX SAVINGS 42" with contains "PIX SAVINGS" ->
 * "Transfer : X 42"), an `is` rule swapped the whole text, the first rule in
 * creation order won, matching was a plain lower-case comparison.
 *
 * It is NOT used to decide anything new. Rows imported under that behaviour are
 * stored with the payee it produced; a later bank sync or statement import of the
 * same data must still see them as what they are (unchanged / the same import
 * key), so it asks this module what the same text used to resolve to. The
 * function bodies are the earlier ones, frozen; domain/legacy-rename.test.ts
 * (rename-rules-legacy.test.ts) checks them against rows captured from that code.
 */
import { matchRule } from '@shared/domain/payees';
import type { LoadedRenameRule } from '../store/rename-rules';

/**
 * Did the earlier behaviour fire this rule? The comparison is the shared one
 * (`normalizeRuleText`: lower case, nothing else, exactly main's): ONE function
 * for the matcher and for this one, so the two cannot drift apart again.
 */
function legacyMatches(rule: LoadedRenameRule, name: string): boolean {
  return (rule.match_type === 'is' || rule.match_type === 'contains') && matchRule(rule, name);
}

/**
 * Every text the earlier behaviour can have resolved `name` to: the splice of EACH matching is/contains rule, not just
 * the first. Main took "the first rule" in the order Postgres returned the rows of equal `created_at` (a fresh-start copy
 * gives every payee one), an order nothing here can rebuild; a stored row is recognised if it is any of them.
 * Empty when no rule matches (the text itself is then the only form, which is not "earlier").
 */
export function legacyEffectiveTexts(rules: readonly LoadedRenameRule[], name: string): string[] {
  const out = new Set<string>();
  for (const rule of rules) {
    if (!legacyMatches(rule, name)) continue;
    if (rule.match_type === 'is') {
      out.add(rule.replacement);
      continue;
    }
    const replaced = name.toLowerCase().split(rule.condition.toLowerCase()).join(rule.replacement);
    // A splice that comes out blank falls through to the next rule (and, with none left, to the text itself).
    out.add(replaced.trim() ? replaced.trim() : name);
  }
  return [...out];
}
