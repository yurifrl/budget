/**
 * "Linked by <avatar> Ana" — small secondary line saying who connected the
 * bank behind a connection / linked account. Renders nothing without a
 * `linked_by`. The one place this line is drawn.
 */
import { Text, View } from 'react-native';

import { Avatar } from '@/ui/avatar/Avatar';

import type { LinkedByJson } from '../data/connections';
import { linkedByView } from '../model/banks/connections';
import { colors } from './theme';

export function LinkedBy({ linkedBy, size = 16 }: { linkedBy: LinkedByJson | null | undefined; size?: number }) {
  const view = linkedByView(linkedBy);
  if (!view) return null;
  return (
    <View
      accessible
      accessibilityLabel={`Linked by ${view.label}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, alignSelf: 'flex-start' }}>
      <Text style={{ color: colors.faint, fontSize: 11 }}>Linked by</Text>
      <Avatar person={view.person} size={size} />
      <Text style={{ color: colors.muted, fontSize: 11 }} numberOfLines={1}>
        {view.label}
      </Text>
    </View>
  );
}
