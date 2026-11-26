/**
 * The two things left of the old "treat as transfer" rule on an ordinary
 * payee: converting a rule which sent its rows to an account into renaming
 * rules on that account's transfer payee, and the "Never a transfer" choice.
 * Both go through the existing transfer-rule endpoint (mode off / never).
 *
 * A conversion is an explicit step. The steps and their failure handling are
 * the pure `runConversion` (convertRun.logic.ts); this hook only wires it to
 * the API and the screen state.
 */

import { useState } from 'react';

import { apiErrorCode, apiErrorMessage, apiErrorParam } from '@/platform/api/baseQuery';
import {
  useAddPayeeRenameRuleMutation,
  useLazyGetPayeeRenameRulesQuery,
  useRemovePayeeRenameRuleMutation,
  useSetPayeeTransferRuleMutation,
} from '@/budget/data/api';
import type { PayeeAdminRow } from '@/budget/data/rows';
import { conversionMessage, runConversion, type ConvertApi } from './convertRun.logic';
import { t } from './i18n';
import type { ConversionPlan } from './renameRules.logic';

export function useTransferRuleChoice({ budgetId, payee }: { budgetId: string; payee: PayeeAdminRow }) {
  const [setRule] = useSetPayeeTransferRuleMutation();
  const [addRule] = useAddPayeeRenameRuleMutation();
  const [removeRule] = useRemovePayeeRenameRuleMutation();
  const [readRules] = useLazyGetPayeeRenameRulesQuery();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const api: ConvertApi = {
    readRules: (payeeId) => readRules({ budgetId, payeeId }, false).unwrap(),
    addRule: (payeeId, rule) => addRule({ budgetId, payeeId, rule }).unwrap(),
    removeRule: async (payeeId, ruleId) => {
      await removeRule({ budgetId, payeeId, ruleId }).unwrap();
    },
    turnOff: async () => {
      await setRule({ budgetId, payeeId: payee.id, rule: { mode: 'off' } }).unwrap();
    },
    classify: (err) => ({ status: (err as { status?: unknown } | null)?.status, code: apiErrorCode(err), holder: apiErrorParam(err, 'name') }),
  };

  /**
   * Save `plan` on `target`, then switch the old rule off. `shown` is the
   * payee's rules as the notice displays them: if they changed since, nothing
   * is written. Resolves true when everything went through.
   */
  const convert = async (target: PayeeAdminRow, plan: ConversionPlan['rules']): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await runConversion({ payeeId: payee.id, targetId: target.id, shown: payee.rename_rules ?? [], plan, api });
      if (result.ok) return true;
      setError(conversionMessage(result, (cause) => apiErrorMessage(cause, t('error.convert'))));
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
