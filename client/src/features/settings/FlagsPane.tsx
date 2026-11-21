import { Text, TextInput, View } from 'react-native';

import { useAppDispatch } from '@/state/hooks';

import { defaultFlagLabel } from '@/domain/flagLabels';
import { useFlagLabels } from '@/state/useDisplayPrefs';
import { setFlagLabel } from '@/state/ui';
import { FLAG_COLORS, colors } from '@/ui/theme';
import { t } from './i18n';
import { s } from './styles';

/** Edit Flags: 6 fixed colors, editable labels (YNAB parity). */
export function FlagsPane() {
  const dispatch = useAppDispatch();
  const flagLabels = useFlagLabels();
  return (
    <>
      <Text style={s.hint}>{t('flags.hint')}</Text>
      {FLAG_COLORS.map((f) => (
        <View key={f.key} style={s.flagRow}>
          <View style={[s.flagDot, { backgroundColor: f.hex }]} />
          <TextInput
            value={flagLabels[f.key]}
            onChangeText={(label) => dispatch(setFlagLabel({ color: f.key, label }))}
            placeholder={defaultFlagLabel(f.key)}
            placeholderTextColor={colors.faint}
            style={s.flagInput}
            accessibilityLabel={t('flags.inputLabel', { color: defaultFlagLabel(f.key) })}
          />
        </View>
      ))}
    </>
  );
}
