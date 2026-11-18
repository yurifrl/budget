import { useState } from 'react';
import { Text, TextInput } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useMenuNav } from '@/shell/SettingsMenu';
import { useAppDispatch, useAppSelector } from '@/store/hooks';

import { useDeleteBudgetMutation } from '../../data/api';
import type { BudgetRow } from '../../data/rows';
import { clearActiveBudget } from '../../state/thunks';
import { selectActiveBudgetId } from '../../state/ui';
import { OverlaySheet } from '../../ui/primitives/OverlaySheet';
import { MenuRow } from './menuRows';
import { refetchBudgets } from './refetchBudgets';
import { deleteBudgetNote, isDeleteArmed } from './settings.logic';
import { s } from './styles';

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
        setError(apiErrorMessage(err));
      });
  };

  return (
    <OverlaySheet visible onClose={onClose} title="Delete Permanently">
      <Text style={s.dangerNote}>
        {deleteBudgetNote(target.name)}
      </Text>
      <TextInput
        value={confirmText}
        onChangeText={setConfirmText}
        placeholder='Type "delete" to confirm'
        placeholderTextColor="#5f6878"
        autoCapitalize="none"
        autoCorrect={false}
        style={s.input}
        accessibilityLabel="Type delete to confirm permanent deletion"
        autoFocus
        onSubmitEditing={del}
      />
      <MenuRow label="Delete Forever" chevron="✕" onPress={del} emphasized={armed} />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
    </OverlaySheet>
  );
}
