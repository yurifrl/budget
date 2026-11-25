/**
 * The two things left of the old "treat as transfer" rule on an ordinary
 * payee: converting a rule which sent its rows to an account into renaming
 * rules on that account's transfer payee, and the "Never a transfer" choice.
 * Both go through the existing transfer-rule endpoint (mode off / never).
 *
 * A conversion is an explicit step: the caller passes the rules the person saw
 * and edited. They are saved one by one (a rule of the payee itself is MOVED:
 * a rule belongs to one payee), and the old setting is switched off only after
 * every one was saved. Any other failure stops there and leaves the old rule on.
 * A retry skips what is already done.
 */

import { useRef, useState } from 'react';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import {
  useAddPayeeRenameRuleMutation,
  useRemovePayeeRenameRuleMutation,
  useSetPayeeTransferRuleMutation,
} from '@/budget/data/api';
import type { PayeeAdminRow } from '@/budget/data/rows';
import { t } from './i18n';
import { targetHasRule, type ConversionPlan } from './renameRules.logic';

const codeOf = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; data?: { code?: unknown } } | null;
  return typeof e?.code === 'string' ? e.code : typeof e?.data?.code === 'string' ? e.data.code : undefined;
};
const statusOf = (err: unknown): unknown => (err as { status?: unknown } | null)?.status;

export function useTransferRuleChoice({ budgetId, payee }: { budgetId: string; payee: PayeeAdminRow }) {
  const [setRule] = useSetPayeeTransferRuleMutation();
  const [addRule] = useAddPayeeRenameRuleMutation();
  const [removeRule] = useRemovePayeeRenameRuleMutation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Entries already saved by an earlier attempt of this conversion.
  const done = useRef(new Set<string>());

  /** Save `plan` on `target`, then switch the old rule off. Resolves true when everything went through. */
  const convert = async (target: PayeeAdminRow, plan: ConversionPlan['rules']): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      for (const r of plan) {
        if (done.current.has(r.key)) continue;
        const body = { match_type: r.matchType, condition: r.text };
        if (r.moveFrom) {
          const original = payee.rename_rules?.find((x) => x.id === r.moveFrom);
          // Gone already (an earlier attempt moved it): nothing to remove.
          if (original) {
            try {
              await removeRule({ budgetId, payeeId: payee.id, ruleId: r.moveFrom }).unwrap();
            } catch (err) {
              if (statusOf(err) !== 404) throw err;
            }
          }
          try {
            await addRule({ budgetId, payeeId: target.id, rule: body }).unwrap();
          } catch (err) {
            if (codeOf(err) !== 'rename_rule_exists') {
              // Put the payee's own rule back before reporting.
              if (original) {
                await addRule({ budgetId, payeeId: payee.id, rule: { match_type: original.match_type, condition: original.condition } })
                  .unwrap()
                  .catch(() => undefined);
              }
              throw err;
            }
          }
        } else if (!targetHasRule(target, r)) {
          try {
            await addRule({ budgetId, payeeId: target.id, rule: body }).unwrap();
          } catch (err) {
            if (codeOf(err) !== 'rename_rule_exists') throw err;
          }
        }
        done.current.add(r.key);
      }
      await setRule({ budgetId, payeeId: payee.id, rule: { mode: 'off' } }).unwrap();
      return true;
    } catch (err) {
      setError(apiErrorMessage(err, t('error.convert')));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setNever = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setRule({ budgetId, payeeId: payee.id, rule: { mode: on ? 'never' : 'off' } }).unwrap();
    } catch (err) {
      setError(apiErrorMessage(err, t('error.never')));
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, convert, setNever };
}
