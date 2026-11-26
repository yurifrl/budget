import type { ComponentRef, Ref } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { colors, radius } from '@/ui/theme';

export type InputRef = ComponentRef<typeof TextInput>;

interface Props extends TextInputProps {
  inputRef?: Ref<InputRef>;
  label: string;
  invalid?: boolean;
  /**
   * A stored credential secret (Pluggy secret), never a login
   * password: web browsers get autocomplete="new-password" so they do not
   * offer to save or fill it as the site's password.
   */
  credential?: boolean;
}

/** A labelled text input in the app's look (also used for the e-mail). Pass FIELD_HINTS for autofill. */
export function PasswordField({ label, invalid, inputRef, style, credential, autoComplete, ...rest }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        ref={inputRef}
        accessibilityLabel={label}
        placeholderTextColor={colors.faint}
        autoComplete={autoComplete ?? (credential ? 'new-password' : undefined)}
        {...rest}
        style={[styles.input, invalid ? styles.invalid : null, style]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  input: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.card10,
    color: colors.text,
    fontSize: 16,
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  invalid: { borderColor: colors.red },
});
