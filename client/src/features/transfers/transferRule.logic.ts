/**
 * "Always treat X as a transfer" (the popover's checkbox): the renaming rule it
 * creates on the other account's transfer payee. The rule is built from the
 * row's bank text: "is <the whole text>" by default, or "starts with <stable
 * prefix>" when the text has a variable tail (a number, a date), which a whole
 * text rule would never match again. The person can edit both before linking.
 * Pure; tested in transferRule.logic.test.ts.
 */

import { MIN_RULE_PATTERN_LENGTH, type RuleMatchType } from '@shared/domain/payees';

import { t } from './i18n';

/** What the popover's rule editor holds. */
export interface RuleDraft {
  matchType: RuleMatchType;
  text: string;
}

/** The four match types, in the order the popover offers them. */
export const RULE_TYPES: readonly RuleMatchType[] = ['is', 'starts_with', 'ends_with', 'contains'];

/** A prefix this short would match too much ("PIX"): such a text stays an "is" rule. */
const MIN_PREFIX = 5;

const hasDigit = (word: string) => /\d/.test(word);

/**
 * The rule to offer for a bank text. No digits in it: "is <text>". Otherwise the
 * words before the first one holding a digit (trailing separators such as `*`,
 * `-`, `:` dropped) become "starts with", when that prefix is long enough to
 * mean something; else the whole text stays an "is" rule.
 */
export function suggestRule(bankText: string): RuleDraft {
  const text = bankText.trim().replace(/\s+/g, ' ');
  const words = text.split(' ');
  const firstVariable = words.findIndex(hasDigit);
  if (firstVariable <= 0) return { matchType: 'is', text };
  const prefix = words
    .slice(0, firstVariable)
    .join(' ')
    .replace(/[\s*\-:#/.,]+$/, '');
  return prefix.length >= MIN_PREFIX ? { matchType: 'starts_with', text: prefix } : { matchType: 'is', text };
}

/**
 * The rule a link creates, or null when none should be (checkbox off, no text,
 * or a "contains" / "starts with" / "ends with" pattern the server would refuse
 * as too short).
 */
export function ruleToCreate(on: boolean, draft: RuleDraft): { match_type: RuleMatchType; condition: string } | null {
  const condition = draft.text.trim();
  if (!on || condition === '') return null;
  if (draft.matchType !== 'is' && condition.length < MIN_RULE_PATTERN_LENGTH) return null;
  return { match_type: draft.matchType, condition };
}

/** The `code` of a failed request (RTK Query error or thrown API error), if it has one. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; data?: { code?: unknown } };
  if (typeof e.code === 'string') return e.code;
  return typeof e.data?.code === 'string' ? e.data.code : undefined;
}

/**
 * What a 409 "rule exists" means for the popover's rule: saved only when the
 * transfer payee ITSELF holds that rule (read again from the server); when an
 * ordinary payee holds it, the rule was not saved and the message names that
 * payee (the error's `name`), when the server said who.
 */
export function ruleExistsOutcome(
  targetRules: readonly { match_type: RuleMatchType; condition: string }[],
  body: { match_type: RuleMatchType; condition: string },
  holder: string | undefined,
): { saved: boolean; message?: string } {
  const norm = (x: string) => x.trim().toLowerCase();
  if (targetRules.some((r) => r.match_type === body.match_type && norm(r.condition) === norm(body.condition))) return { saved: true };
  return { saved: false, message: holder ? t('rule.notSaved.held', { payee: holder }) : t('rule.notSaved.heldUnknown') };
}
