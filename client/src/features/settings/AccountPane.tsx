import { Text } from 'react-native';

import { useMenuNav } from '@/shell/menuNav';

import { useGetMeQuery } from '@/budget/data/api';
import { MenuRow } from './menuRows';
import { s } from './styles';

/** Account Settings: signed-in email + Back to Plan. */
export function AccountPane() {
  const nav = useMenuNav();
  const me = useGetMeQuery();
  return (
    <>
      <Text style={s.hint}>Signed in as</Text>
      <Text style={s.accountEmail}>{me.data?.email ?? '…'}</Text>
      <MenuRow label="Back to Plan" emphasized onPress={nav.close} />
    </>
  );
}
