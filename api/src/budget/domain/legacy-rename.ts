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
 * checks them against rows captured from that code.
 */
import type { LoadedRenameRule } from '../store/rename-rules';

function legacyMatches(rule: LoadedRenameRule, name: string): boolean {
  const needle = rule.condition.toLowerCase();
  if (needle === '') return false;
  const hay = name.toLowerCase();
  return rule.match_type === 'is' ? hay === needle : hay.includes(needle);
}

/** The text the earlier behaviour resolved `name` to: the first matching is/contains rule applied. */
export function legacyEffectiveText(rules: readonly LoadedRenameRule[], name: string): string {
  for (const rule of rules) {
    if (rule.match_type !== 'is' && rule.match_type !== 'contains') continue;
    if (!legacyMatches(rule, name)) continue;
    if (rule.match_type === 'is') return rule.replacement;
    const replaced = name.toLowerCase().split(rule.condition.toLowerCase()).join(rule.replacement);
    if (replaced.trim()) return replaced.trim();
  }
  return name;
}
