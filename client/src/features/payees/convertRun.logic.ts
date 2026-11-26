/**
 * The commit plan of "Convert" (old "treat as transfer" rule -> renaming rules
 * on an account's transfer payee), as pure logic over an injected API so every
 * failure point can be tested. The rules to create (some of them MOVED from the
 * payee itself: a rule belongs to one payee, and the server's duplicate check
 * is budget-wide) are written so that nothing can be lost:
 *
 *  1. re-read the payee's rules and refuse when they are not what the notice
 *     showed (the Renaming card below may have changed them);
 *  2. per rule: re-read the target; a rule the target already holds is done;
 *     a new rule is added; a moved rule is removed from the payee and then
 *     added to the target, and put back on the payee if that add fails;
 *  3. a 409 "exists" counts as done ONLY when the target's own rules (read
 *     again) hold that rule; any other holder stops the conversion;
 *  4. only then the old setting is switched off.
 * When a step stops the run, the state is put back exactly as before it: the
 * moves are undone AND the rules this run created on the target are removed
 * (by id; one the target held before is never touched). Whatever cannot be put
 * back is named with where it is, never swallowed. The one exception is the
 * last step: when only "switch the old setting off" fails, the rules stay on
 * the target (a retry only repeats that step) and the result says so.
 */

import type { RuleMatchType } from '@shared/domain/payees';

import { t } from './i18n';
import { RULE_MATCH_LABEL, type ConversionPlan } from './renameRules.logic';

export interface RuleRef {
  id: string;
  match_type: RuleMatchType;
  condition: string;
}

export interface RuleBody {
  match_type: RuleMatchType;
  condition: string;
}

/** What a failed request says, as far as the plan needs it. */
export interface FailureInfo {
  status?: unknown;
  code?: string;
  /** The payee that holds a clashing rule (a 409's `params.name`). */
  holder?: string;
}

export interface ConvertApi {
  readRules(payeeId: string): Promise<RuleRef[]>;
  addRule(payeeId: string, body: RuleBody): Promise<RuleRef>;
  removeRule(payeeId: string, ruleId: string): Promise<void>;
  /** Switch the old "treat as transfer" setting off. */
  turnOff(): Promise<void>;
  classify(err: unknown): FailureInfo;
}

export type ConvertFailure =
  | { kind: 'stale' }
  /** Every rule is saved; only switching the old setting off failed. */
  | { kind: 'offFailed'; cause: unknown }
  | { kind: 'held'; rule: string; holder: string | null }
  | { kind: 'error'; cause: unknown };

export type ConvertResult =
  | { ok: true }
  | {
      ok: false;
      failure: ConvertFailure;
      /** Rules on NEITHER payee now (could not be put back on the payee), by name. */
      unrestored: string[];
      /** Rules that are on the target and could not be taken off it, by name. */
      onTarget: string[];
    };

const norm = (s: string) => s.trim().toLowerCase();
const same = (r: RuleBody, type: RuleMatchType, text: string) => r.match_type === type && norm(r.condition) === norm(text);
const holds = (rules: readonly RuleRef[], type: RuleMatchType, text: string) => rules.some((r) => same(r, type, text));

/** "Contains “PIX JOAO”": a rule named for a message. */
export const ruleLabel = (type: RuleMatchType, text: string): string => `${RULE_MATCH_LABEL[type]} “${text}”`;

/** True when the two lists hold the same rules (id, type, text). */
export function sameRuleSet(a: readonly RuleRef[], b: readonly RuleRef[]): boolean {
  const key = (r: RuleRef) => `${r.id}\u0000${r.match_type}\u0000${norm(r.condition)}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
}

export async function runConversion({
  payeeId,
  targetId,
  shown,
  plan,
  api,
}: {
  payeeId: string;
  targetId: string;
  /** The payee's rules as the notice was showing them. */
  shown: readonly RuleRef[];
  plan: ConversionPlan['rules'];
  api: ConvertApi;
}): Promise<ConvertResult> {
  const moved: { added: RuleRef; original: RuleRef }[] = [];
  const created: { added: RuleRef; name: string }[] = [];
  const unrestored: string[] = [];
  const onTarget: string[] = [];

  /** Put everything this run changed back (moves newest first, then created rules), then report the failure. */
  const abort = async (failure: ConvertFailure): Promise<ConvertResult> => {
    for (const m of [...moved].reverse()) {
      const name = ruleLabel(m.original.match_type, m.original.condition);
      try {
        await api.removeRule(targetId, m.added.id);
      } catch {
        // Still on the target: putting it back on the payee would clash.
        onTarget.push(name);
        continue;
      }
      try {
        await api.addRule(payeeId, { match_type: m.original.match_type, condition: m.original.condition });
      } catch {
        unrestored.push(name);
      }
    }
    for (const c of [...created].reverse()) {
      try {
        await api.removeRule(targetId, c.added.id);
      } catch {
        onTarget.push(c.name);
      }
    }
    return { ok: false, failure, unrestored, onTarget };
  };

  let current: RuleRef[];
  try {
    current = await api.readRules(payeeId);
  } catch (cause) {
    return abort({ kind: 'error', cause });
  }
  if (!sameRuleSet(shown, current)) return abort({ kind: 'stale' });

  for (const r of plan) {
    const label = ruleLabel(r.matchType, r.text);
    const body: RuleBody = { match_type: r.matchType, condition: r.text };
    try {
      if (holds(await api.readRules(targetId), r.matchType, r.text)) continue; // done already (an earlier attempt, or it was there)

      if (!r.moveFrom) {
        try {
          created.push({ added: await api.addRule(targetId, body), name: label });
        } catch (err) {
          if (api.classify(err).code === 'rename_rule_exists') {
            if (holds(await api.readRules(targetId), r.matchType, r.text)) continue;
            return abort({ kind: 'held', rule: label, holder: api.classify(err).holder ?? null });
          }
          throw err;
        }
        continue;
      }

      const original = current.find((x) => x.id === r.moveFrom);
      if (!original) return abort({ kind: 'stale' });
      try {
        await api.removeRule(payeeId, original.id);
      } catch (err) {
        if (api.classify(err).status === 404) return abort({ kind: 'stale' });
        throw err;
      }
      // From here the rule is on neither payee until the add lands: put it back if it does not.
      const putBack = async () => {
        try {
          await api.addRule(payeeId, { match_type: original.match_type, condition: original.condition });
        } catch {
          unrestored.push(ruleLabel(original.match_type, original.condition));
        }
      };
      try {
        moved.push({ added: await api.addRule(targetId, body), original });
      } catch (err) {
        const info = api.classify(err);
        if (info.code === 'rename_rule_exists') {
          const now = await api.readRules(targetId).catch(() => [] as RuleRef[]);
          // The target holds it: the rule is where it belongs, and not this run's to undo (it was not added here).
          if (now.some((x) => same(x, r.matchType, r.text))) continue;
          await putBack();
          return abort({ kind: 'held', rule: label, holder: info.holder ?? null });
        }
        await putBack();
        return abort({ kind: 'error', cause: err });
      }
    } catch (cause) {
      return abort({ kind: 'error', cause });
    }
  }

  try {
    await api.turnOff();
  } catch (cause) {
    // Every rule is saved: keep them where they are; a retry only switches the setting off.
    return { ok: false, failure: { kind: 'offFailed', cause }, unrestored: [], onTarget: [] };
  }
  return { ok: true };
}

/** The sentence for a failed conversion (translated); `describe` turns an unknown cause into a message. */
export function conversionMessage(
  result: Extract<ConvertResult, { ok: false }>,
  describe: (cause: unknown) => string,
  targetName: string,
): string {
  const f = result.failure;
  if (f.kind === 'offFailed') return `${t('legacy.offFailed', { target: targetName })} ${describe(f.cause)}`;
  const base =
    f.kind === 'stale'
      ? t('legacy.stale')
      : f.kind === 'held'
        ? f.holder
          ? t('legacy.held', { rule: f.rule, payee: f.holder })
          : t('legacy.heldUnknown', { rule: f.rule })
        : describe(f.cause);
  const parts = [base];
  if (result.unrestored.length > 0) parts.push(t('legacy.unrestored', { rules: result.unrestored.join(', ') }));
  if (result.onTarget.length > 0) parts.push(t('legacy.onTarget', { rules: result.onTarget.join(', '), target: targetName }));
  if (parts.length === 1) parts.push(t('legacy.nothingChanged'));
  return parts.join(' ');
}
