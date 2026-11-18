import { Text, TextInput, View } from 'react-native';

import { useAppDispatch } from '@/state/hooks';

import { defaultFlagLabel } from '@/domain/flagLabels';
import { useFlagLabels } from '@/state/useDisplayPrefs';
import { setFlagLabel } from '@/state/ui';
import { FLAG_COLORS } from '@/ui/theme';
import { s } from './styles';

/** Edit Flags: 6 fixed colors, editable labels (YNAB parity). */
export function FlagsPane() {
  const dispatch = useAppDispatch();
  const flagLabels = useFlagLabels();
  return (
    <>
      <Text style={s.hint}>{`Labels shown in the register's flag menu. Blank uses the color name.`}</Text>
      {FLAG_COLORS.map((f) => (
        <View key={f.key} style={s.flagRow}>
          <View style={[s.flagDot, { backgroundColor: f.hex }]} />
          <TextInput
            value={flagLabels[f.key]}
            onChangeText={(label) => dispatch(setFlagLabel({ color: f.key, label }))}
            placeholder={defaultFlagLabel(f.key)}
            placeholderTextColor="#5f6878"
            style={s.flagInput}
            accessibilityLabel={`${defaultFlagLabel(f.key)} flag label`}
          />
        </View>
      ))}
    </>
  );
}
