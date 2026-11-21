/**
 * PersonFace — the one way a budget "owner" is drawn: a member's avatar, or
 * the neutral household glyph for Shared (`person === null`). Every place that
 * shows who an account belongs to (rail, picker, register header, plan
 * filter, caption) goes through here, so Shared looks identical everywhere.
 */
import Svg, { Circle, Path } from 'react-native-svg';
import { Pressable, Text, View } from 'react-native';

import { Avatar } from './avatar/Avatar';

import { personLabel, toAvatarPerson, type Person } from '@/domain/people';
import { colors } from '@/ui/theme';

import { t } from './text/i18n';

/** Two-people glyph in a neutral circle: "belongs to the household". */
export function SharedGlyph({ size = 24 }: { size?: number }) {
  return (
    <View
      accessibilityLabel={t('person.shared')}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.card2,
        borderWidth: 1,
        borderColor: colors.border2,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24">
        <Circle cx={9} cy={8.5} r={3.4} fill={colors.muted} />
        <Path d="M2.5 19.5c0-3.4 2.9-5.6 6.5-5.6s6.5 2.2 6.5 5.6z" fill={colors.muted} />
        <Circle cx={17} cy={9.5} r={2.7} fill={colors.faint} />
        <Path d="M16.2 14.2c3.2-.3 5.8 1.5 5.8 4.6h-4.4c0-1.8-.5-3.3-1.4-4.6z" fill={colors.faint} />
      </Svg>
    </View>
  );
}

export function PersonFace({ person, size = 24 }: { person: Person | null; size?: number }) {
  return person ? <Avatar person={toAvatarPerson(person)} size={size} /> : <SharedGlyph size={size} />;
}

/**
 * Small avatar beside an account for the person it belongs to ("Belongs to
 * Ana"); nothing for Shared, which is the default and would only add noise.
 */
export function AccountOwnerFace({ person, size = 17 }: { person: Person | null; size?: number }) {
  if (!person) return null;
  return (
    <View accessible accessibilityLabel={t('person.belongsTo', { name: personLabel(person) })} {...({ title: t('person.belongsTo', { name: personLabel(person) }) } as object)}>
      <PersonFace person={person} size={size} />
    </View>
  );
}

/** "Belongs to Ana" / "Shared by everyone" line under an account's title; the link-coloured ▾ marks it as the way to change the person (opens the editor). */
export function BelongsTo({ person, onPress }: { person: Person | null; onPress?: () => void }) {
  const text = person ? t('person.belongsTo', { name: personLabel(person) }) : t('person.sharedByEveryone');
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={onPress ? t('person.changePerson', { text }) : text}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5, alignSelf: 'flex-start' }}>
      <PersonFace person={person} size={18} />
      <Text style={{ color: onPress ? colors.indigo3 : colors.muted, fontSize: 12 }} numberOfLines={1}>
        {text}
        {onPress ? ' ▾' : ''}
      </Text>
    </Pressable>
  );
}
