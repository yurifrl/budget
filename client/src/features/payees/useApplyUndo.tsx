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
  /** Set while the Undo of an apply is on offer. */
  applyId: string | null;
  /** Set while the Undo of a removed rule is on offer. */
  restore?: () => Promise<void>;
  error?: boolean;
}

const UNDO_MS = 10_000;
const NOTE_MS = 5_000;

export function useApplyUndo(budgetId: string): {
  show: (result: RenameRuleApplyResult) => void;
  /** A rule was removed: offer Undo, which runs `restore`. */
  showRemoved: (rule: { condition: string }, restore: () => Promise<void>) => void;
  node: ReactNode;
} {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [revert] = useRevertRenameRuleApplyMutation();
  // Phone: lift the toast above the shell's floating "+ Transaction" button, which would cover Undo.
  const narrow = useWindowDimensions().width < 700;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.applyId || toast.restore ? UNDO_MS : NOTE_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const show = useCallback((result: RenameRuleApplyResult) => {
    setToast({ message: appliedMessage(result.changed), applyId: result.changed > 0 ? result.apply_id : null });
  }, []);

  const showRemoved = useCallback((rule: { condition: string }, restore: () => Promise<void>) => {
    setToast({ message: t('rule.removed', { text: rule.condition }), applyId: null, restore });
  }, []);

  const undo = async () => {
    if (toast?.restore) {
      const restore = toast.restore;
      setToast({ message: toast.message, applyId: null });
      try {
        await restore();
        setToast({ message: t('rule.restored'), applyId: null });
      } catch (err) {
        setToast({ message: apiErrorMessage(err, t('rule.undoError')), applyId: null, error: true });
      }
      return;
    }
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
        actionLabel={toast.applyId || toast.restore ? t('apply.undo') : undefined}
        onAction={toast.applyId || toast.restore ? () => void undo() : undefined}
      />
    </View>
  ) : null;
  return { show, showRemoved, node };
}
