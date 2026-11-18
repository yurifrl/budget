import { useState } from 'react';
import { Text, TextInput } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useMenuNav } from '@/shell/menuNav';
import { useAppDispatch } from '@/state/hooks';

import { useCreateBudgetMutation } from '@/budget/data/api';
import { switchBudget } from '@/state/thunks';
import { MenuRow } from './menuRows';
import { refetchBudgets } from '@/state/refetchBudgets';
import { s } from './styles';
import { colors } from '@/ui/theme';

/** New Budget form (the old 'new' view) — create, switch, close. */
export function NewBudgetPane() {
  const nav = useMenuNav();
  const dispatch = useAppDispatch();
  const [createBudget] = useCreateBudgetMutation();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = () => {
    const n = name.trim();
    if (!n) return;
    setError(null);
    createBudget({ name: n })
      .unwrap()
      // Refetch the list before switching (as Fresh Start does): the shell
      // reconciles the active id against the Budgets list and would bounce a
      // not-yet-listed new budget back to the first one (budget-fwf).
      .then(async (created) => {
        await refetchBudgets(dispatch);
        await dispatch(switchBudget(created.id));
      })
      .then(() => nav.close())
      .catch((err) => setError(apiErrorMessage(err)));
  };
  return (
    <>
      <Text style={s.hint}>Creates a fresh Budget instance with a starter group.</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Budget name"
        placeholderTextColor={colors.faint}
        onSubmitEditing={create}
        style={s.input}
        accessibilityLabel="New budget name"
        autoFocus
      />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
      <MenuRow label="Create Budget" emphasized onPress={create} />
    </>
  );
}
