import { useState } from 'react';
import { Text, TextInput } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useMenuNav } from '@/shell/menuNav';
import { useAppDispatch, useAppSelector } from '@/state/hooks';

import { useDeleteBudgetMutation } from '@/budget/data/api';
import type { BudgetRow } from '@/budget/data/rows';
import { clearActiveBudget } from '@/state/thunks';
import { selectActiveBudgetId } from '@/state/ui';
import { OverlaySheet } from '@/ui/primitives/OverlaySheet';
import { t } from './i18n';
import { MenuRow } from './menuRows';
import { refetchBudgets } from '@/state/refetchBudgets';
import { deleteBudgetNote, isDeleteArmed } from './settings.logic';
import { s } from './styles';
import { colors } from '@/ui/theme';

/**
 * Typed-confirmation modal for permanent budget deletion: a "Delete Budget…"
 * row opens this; the delete only fires once "delete" is typed.
 */
export function DeleteBudgetModal({ target, onClose }: { target: BudgetRow; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const nav = useMenuNav();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const [deleteBudget] = useDeleteBudgetMutation();
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const armed = isDeleteArmed(confirmText);
  const del = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    deleteBudget({ id: target.id })
      .unwrap()
      .then(async () => {
        if (target.id === activeBudgetId) {
          void dispatch(clearActiveBudget());
        }
        await refetchBudgets(dispatch);
        nav.back();
      })
      .catch((err) => {
        setBusy(false);
        setError(apiErrorMessage(err, t('delete.failed')));
      });
  };

  return (
    <OverlaySheet visible onClose={onClose} title={t('delete.title')}>
      <Text style={s.dangerNote}>
        {deleteBudgetNote(target.name)}
      </Text>
      <TextInput
        value={confirmText}
        onChangeText={setConfirmText}
        placeholder={t('delete.placeholder')}
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        style={s.input}
        accessibilityLabel={t('delete.inputLabel')}
        autoFocus
        onSubmitEditing={del}
      />
      <MenuRow label={t('delete.confirm')} chevron="✕" onPress={del} emphasized={armed} />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
    </OverlaySheet>
  );
}
