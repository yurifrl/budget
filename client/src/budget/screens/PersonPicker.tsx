/**
 * Person picker for accounts: Shared + one pill per budget member, each with
 * the person's avatar (Shared gets the household glyph) — same pill pattern
 * as AddAccountModal's type chips. Label logic lives in domain/people.ts and
 * the faces in ui/PersonFace.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { personLabel, SHARED_LABEL, type Person } from '../domain/people';
import { usePeople } from '../model/usePeople';
import { PersonFace } from '../ui/PersonFace';
import { colors } from '../ui/theme';

export function PersonPicker({
  budgetId,
  value,
  onChange,
  disabled,
  label = 'Person',
}: {
  budgetId: string;
  /** Selected member id; null = Shared. */
  value: string | null;
  onChange: (userId: string | null) => void;
  disabled?: boolean;
  /** Accessibility label prefix; screens showing several pickers/filters disambiguate with it. */
  label?: string;
}) {
  const { people } = usePeople(budgetId);
  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <PersonOption prefix={label} person={null} on={value === null} disabled={disabled} onPress={() => onChange(null)} />
      {people.map((p) => (
        <PersonOption
          key={p.user_id}
          prefix={label}
          person={p}
          on={value === p.user_id}
          disabled={disabled}
          onPress={() => onChange(p.user_id)}
        />
      ))}
    </View>
  );
}

function PersonOption({
  prefix,
  person,
  on,
  disabled,
  onPress,
}: {
  prefix: string;
  person: Person | null;
  on: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const label = person ? personLabel(person) : SHARED_LABEL;
  return (
    <Pressable
      style={[styles.chip, on && styles.chipOn]}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`${prefix} ${label}`}
      onPress={onPress}>
      <PersonFace person={person} size={20} />
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 999,
    paddingLeft: 4,
    paddingRight: 10,
    paddingVertical: 4,
    maxWidth: 220,
  },
  chipOn: { borderColor: colors.indigo2, backgroundColor: colors.indigo },
  chipText: { color: colors.muted, fontSize: 12, flexShrink: 1 },
  chipTextOn: { color: '#fff', fontWeight: '700' },
});
