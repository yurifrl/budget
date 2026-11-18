import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { colors } from '@/ui/theme';
import { styles } from './styles';

/** Inline "＋ nome…" row: commits on Enter/blur, cancels on empty blur. */
export function InlineAddRow({
  placeholder,
  accessibilityLabel,
  onCommit,
  onCancel,
}: {
  placeholder: string;
  accessibilityLabel: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  return (
    <View style={styles.addRow}>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        autoFocus
        onSubmitEditing={() => {
          const name = value.trim();
          if (name) onCommit(name);
        }}
        onBlur={() => {
          const name = value.trim();
          if (name) onCommit(name);
          else onCancel();
        }}
        style={styles.addRowInput}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}
