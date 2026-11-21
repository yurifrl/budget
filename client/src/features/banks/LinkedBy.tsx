/**
 * "Linked by <avatar> Ana" — small secondary line saying who connected the
 * bank behind a connection / linked account. Renders nothing without a
 * `linked_by`. The one place this line is drawn.
 */
import { Text, View } from 'react-native';

import { Avatar } from '@/ui/avatar/Avatar';

import type { LinkedByJson } from '@/budget/data/connections';
import { linkedByView } from './model/connections';
import { colors } from '@/ui/theme';
import { t } from './i18n';

export function LinkedBy({ linkedBy, size = 16 }: { linkedBy: LinkedByJson | null | undefined; size?: number }) {
  const view = linkedByView(linkedBy);
  if (!view) return null;
  return (
    <View
      accessible
      accessibilityLabel={t('linkedBy.label', { name: view.label })}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, alignSelf: 'flex-start' }}>
      <Text style={{ color: colors.faint, fontSize: 11 }}>{t('linkedBy.prefix')}</Text>
      <Avatar person={view.person} size={size} />
      <Text style={{ color: colors.muted, fontSize: 11 }} numberOfLines={1}>
        {view.label}
      </Text>
    </View>
  );
}
