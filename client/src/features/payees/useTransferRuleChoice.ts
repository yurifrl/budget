/**
 * The two things left of the old "treat as transfer" rule on an ordinary
 * payee: converting a rule that sent its rows to an account into a renaming
 * rule on that account's transfer payee, and the "Never a transfer" choice.
 * Both go through the existing transfer-rule endpoint (mode off / never); the
 * old rule is cleared only after the new one exists.
 */

import { useState } from 'react';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useAddPayeeRenameRuleMutation, useSetPayeeTransferRuleMutation } from '@/budget/data/api';
import type { PayeeAdminRow } from '@/budget/data/rows';
import { t } from './i18n';
import { conversionRule, targetHasConversionRule } from './renameRules.logic';

export function useTransferRuleChoice({ budgetId, payee }: { budgetId: string; payee: PayeeAdminRow }) {
  const [setRule] = useSetPayeeTransferRuleMutation();
  const [addRule] = useAddPayeeRenameRuleMutation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Turn the old rule into `is <payee name>` on the chosen transfer payee, then clear the old rule. */
  const convert = async (target: PayeeAdminRow) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // A conversion that stopped after adding the rule finds it already there.
      if (!targetHasConversionRule(target, payee)) {
        await addRule({ budgetId, payeeId: target.id, rule: conversionRule(payee) }).unwrap();
      }
      await setRule({ budgetId, payeeId: payee.id, rule: { mode: 'off' } }).unwrap();
    } catch (err) {
      setError(apiErrorMessage(err, t('error.convert')));
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
