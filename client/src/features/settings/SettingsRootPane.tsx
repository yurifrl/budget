import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { useMenuNav } from '@/shell/menuNav';
import { useAppSelector } from '@/state/hooks';
import { AvatarStack } from '@/ui/avatar/AvatarStack';

import { toAvatarPerson } from '@/domain/people';
import { useMoneyMask } from '@/state/useDisplayPrefs';
import { useGetBudgetsQuery, useGetMeQuery } from '@/budget/data/api';
import { useSignOutAndLeave } from '@/features/auth';
import { usePeople } from '@/features/people';
import { selectActiveBudgetId } from '@/state/ui';
import { useBudgetShell } from '@/shell/context';
import { t } from './i18n';
import { MenuRow } from './menuRows';
import { canManageBudget } from './settings.logic';
import { MENU_BG, s } from './styles';

/**
 * Root menu, in sections split by hairlines: the budget (identity, All
 * budgets and its rows), the settings, then the account (email, Profile) and
 * Log Out last on its own.
 */
export function SettingsRootPane() {
  const nav = useMenuNav();
  const router = useRouter();
  const { openPayees, closeSidebar, goHome } = useBudgetShell();
  const signOutAndLeave = useSignOutAndLeave();
  const email = useGetMeQuery().data?.email;
  const [masked, setMasked] = useMoneyMask();
  const web = process.env.EXPO_OS === 'web';
  const activeBudgetId = useAppSelector((st) => selectActiveBudgetId(st));
  const budget = useGetBudgetsQuery().data?.find((b) => b.id === activeBudgetId);
  const isOwner = canManageBudget(budget);
  // A row that leaves the menu for a routed page must collapse every layer of
  // chrome: the switcher menu portal, then the tablet/phone drawer holding the
  // rail (no-op on desktop, where the rail sits beside content).
  const leaveForPage = (go: () => void) => {
    nav.close();
    closeSidebar();
    go();
  };
  return (
    <>
      <View style={s.identity}>
        <Text style={s.identityKicker}>{t('root.kicker')}</Text>
        <Text style={s.identityName} numberOfLines={1}>
          {budget?.name ?? t('root.budgetFallback')}
        </Text>
      </View>
      <MenuRow dense label={t('root.allBudgets')} onPress={() => leaveForPage(goHome)} />
      <MenuRow dense label={t('root.open')} onPress={() => nav.open('open')} />
      <MenuRow dense label={t('root.new')} onPress={() => nav.open('new')} />
      <MenuRow dense label={t('root.planSettings')} onPress={() => nav.open('settings')} />
      <PeopleMenuRow onPress={() => nav.open('people')} />
      {isOwner ? <MenuRow dense label={t('root.freshStart')} onPress={() => nav.open('fresh-start')} /> : null}
      <View style={s.divider} />
      <MenuRow dense label={t('root.payees')} onPress={() => leaveForPage(openPayees)} />
      <MenuRow
        dense
        label={t('root.banks')}
        onPress={() => leaveForPage(() => router.push('/connect-bank'))}
      />
      <MenuRow
        dense
        label={t('root.backup')}
        onPress={() => leaveForPage(() => router.push('/backup'))}
      />
      <MenuRow dense label={t('root.jevKey')} onPress={() => leaveForPage(() => router.push('/jev-key'))} />
      <MenuRow dense label={t('root.flags')} onPress={() => nav.open('flags')} />
      <MenuRow dense label={t('root.display')} onPress={() => nav.open('display')} />
      <MenuRow
        dense
        label={t('root.hideAmounts')}
        onPress={() => setMasked(!masked)}
        chevron={masked ? '🔒' : undefined}
      />
      <Text style={s.rootHint}>
        {masked ? t('root.hiddenHint') : t('root.maskHint')}
      </Text>
      {web ? <MenuRow dense label={t('root.shortcuts')} onPress={() => nav.open('shortcuts')} /> : null}
      <MenuRow dense label={t('root.account')} onPress={() => nav.open('account')} />
      <View style={s.divider} />
      {email ? (
        <Text style={s.sectionMeta} numberOfLines={1}>
          {email}
        </Text>
      ) : null}
      <MenuRow dense label={t('root.profile')} onPress={() => leaveForPage(() => router.push('/profile'))} />
      <View style={s.divider} />
      <MenuRow dense label={t('root.logOut')} chevron="" onPress={() => leaveForPage(signOutAndLeave)} />
    </>
  );
}

/** Settings "People" row with an at-a-glance stack of who the budget is shared with. */
function PeopleMenuRow({ onPress }: { onPress: () => void }) {
  const budgetId = useAppSelector((st) => selectActiveBudgetId(st));
  const { people } = usePeople(budgetId);
  return (
    <MenuRow
      dense
      label={t('root.people')}
      onPress={onPress}
      trailing={
        people.length > 0 ? (
          <AvatarStack people={people.map(toAvatarPerson)} max={4} size={22} ring={MENU_BG} style={{ marginRight: 8 }} />
        ) : undefined
      }
    />
  );
}
