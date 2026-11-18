import { useState } from 'react';
import { Text, TextInput } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useMenuNav } from '@/shell/SettingsMenu';
import { useAppDispatch } from '@/store/hooks';

import { useCreateBudgetMutation } from '../../data/api';
import { switchBudget } from '../../state/thunks';
import { MenuRow } from './menuRows';
import { s } from './styles';

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
      .then((created) => dispatch(switchBudget(created.id)))
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
        placeholderTextColor="#5f6878"
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
