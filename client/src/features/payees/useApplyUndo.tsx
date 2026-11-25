/**
 * The bottom toast after "Apply to past transactions": what changed, with
 * Undo (revert by apply_id) for a while. After the undo the toast says what
 * was put back. The screen owns it, so it survives picking another payee.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { View, useWindowDimensions } from 'react-native';

import { useRevertRenameRuleApplyMutation, type RenameRuleApplyResult } from '@/budget/data/api';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { ActionToast } from '@/ui/primitives/ActionToast';
import { t } from './i18n';
import { styles } from './styles';
import { appliedMessage, revertedMessage } from './renameRules.logic';

interface ToastState {
  message: string;
  /** Set while the Undo is on offer. */
  applyId: string | null;
  error?: boolean;
}

const UNDO_MS = 10_000;
const NOTE_MS = 5_000;

export function useApplyUndo(budgetId: string): { show: (result: RenameRuleApplyResult) => void; node: ReactNode } {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [revert] = useRevertRenameRuleApplyMutation();
  // Phone: lift the toast above the shell's floating "+ Transaction" button, which would cover Undo.
  const narrow = useWindowDimensions().width < 700;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.applyId ? UNDO_MS : NOTE_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const show = useCallback((result: RenameRuleApplyResult) => {
    setToast({ message: appliedMessage(result.changed), applyId: result.changed > 0 ? result.apply_id : null });
  }, []);

  const undo = async () => {
    const applyId = toast?.applyId;
    if (!applyId) return;
    setToast({ message: toast.message, applyId: null });
    try {
      const result = await revert({ budgetId, applyId }).unwrap();
      setToast({ message: revertedMessage(result), applyId: null });
    } catch (err) {
      setToast({ message: apiErrorMessage(err, t('apply.error.undo')), applyId: null, error: true });
    }
  };

  const node = toast ? (
    <View pointerEvents="box-none" style={[styles.toastHost, narrow && styles.toastHostPhone]}>
      <ActionToast
        message={toast.message}
        leading={toast.error ? null : '✓'}
        actionLabel={toast.applyId ? t('apply.undo') : undefined}
        onAction={toast.applyId ? () => void undo() : undefined}
      />
    </View>
  ) : null;
  return { show, node };
}
