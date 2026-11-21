/** Overlapping avatars with a "+N" overflow chip — for lists of people. */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { t } from '../text/i18n';
import { Avatar } from './Avatar';
import type { AvatarPerson } from './types';

export interface AvatarStackProps {
  people: AvatarPerson[];
  /** Avatars shown before collapsing the rest into "+N". */
  max?: number;
  size?: number;
  /** Separator ring color — match the surface the stack sits on. */
  ring?: string;
  style?: StyleProp<ViewStyle>;
}

export function AvatarStack({ people, max = 3, size = 24, ring = '#0c0f16', style }: AvatarStackProps) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  const overlap = Math.round(size * 0.3);
  return (
    <View style={[styles.row, style]} accessibilityLabel={t('avatarStack.label', { count: people.length })}>
      {shown.map((p, i) => (
        <Avatar key={p.id} person={p} size={size} ring={ring} style={i > 0 ? { marginLeft: -overlap } : undefined} />
      ))}
      {extra > 0 ? (
        <View
          style={[
            styles.more,
            { width: size, height: size, borderRadius: size / 2, borderColor: ring, marginLeft: -overlap },
          ]}>
          <Text style={[styles.moreText, { fontSize: Math.max(8, size * 0.38) }]}>{`+${extra}`}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  more: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#252c3b', borderWidth: 2 },
  moreText: { color: '#98a2b5', fontWeight: '700' },
});
