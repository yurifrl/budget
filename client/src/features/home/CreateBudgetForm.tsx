/** Name field + "Create budget": inline on the first-run page, in a sheet otherwise. */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius } from '@/ui/theme';

import { NAME_MAX } from './home.logic';

interface Props {
  onCreate: (name: string) => Promise<boolean>;
  creating: boolean;
  error: string | null;
  onEdit: () => void;
  autoFocus?: boolean;
  /** Side by side (wide) or stacked with a full-width button. */
  inline?: boolean;
}

export function CreateBudgetForm({ onCreate, creating, error, onEdit, autoFocus = false, inline = false }: Props) {
  const [name, setName] = useState('');
  const submit = () => void onCreate(name);
  return (
    <View style={styles.form}>
      <View style={[styles.fields, inline && styles.fieldsInline]}>
        <TextInput
          value={name}
          onChangeText={(v) => {
            setName(v);
            onEdit();
          }}
          placeholder="Budget name, for example Home"
          placeholderTextColor={colors.faint}
          onSubmitEditing={submit}
          editable={!creating}
          autoFocus={autoFocus}
          maxLength={NAME_MAX}
          returnKeyType="done"
          accessibilityLabel="New budget name"
          style={[styles.input, inline && styles.inputInline, error ? styles.inputError : null]}
        />
        <Pressable
          onPress={submit}
          disabled={creating}
          accessibilityRole="button"
          accessibilityLabel="Create budget"
          accessibilityState={{ disabled: creating, busy: creating }}
          style={(state) => [
            styles.button,
            (state.pressed || ('hovered' in state && state.hovered === true)) && styles.buttonActive,
          ]}>
          {creating ? (
            <ActivityIndicator size="small" color={colors.white} />
          ) : (
            <Text style={styles.buttonText}>Create budget</Text>
          )}
        </Pressable>
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 8 },
  fields: { gap: 12 },
  fieldsInline: { flexDirection: 'row', alignItems: 'center' },
  input: {
    minHeight: 50,
    borderRadius: radius.card10,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 14,
  },
  inputInline: { flex: 1, minWidth: 0 },
  inputError: { borderColor: colors.red },
  button: {
    minHeight: 50,
    minWidth: 168,
    paddingHorizontal: 28,
    borderRadius: radius.card10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.indigo,
  },
  buttonActive: { backgroundColor: colors.indigo2 },
  buttonText: { color: colors.white, fontSize: 16, fontWeight: '700' },
  error: { color: colors.redFg, fontSize: 14, lineHeight: 20 },
});
