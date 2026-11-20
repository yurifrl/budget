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
        <Text style={s.identityKicker}>BUDGET</Text>
        <Text style={s.identityName} numberOfLines={1}>
          {budget?.name ?? 'Budget'}
        </Text>
      </View>
      <MenuRow dense label="All budgets" onPress={() => leaveForPage(goHome)} />
      <MenuRow dense label="Open Budget" onPress={() => nav.open('open')} />
      <MenuRow dense label="New Budget" onPress={() => nav.open('new')} />
      <MenuRow dense label="Plan Settings" onPress={() => nav.open('settings')} />
      <PeopleMenuRow onPress={() => nav.open('people')} />
      {isOwner ? <MenuRow dense label="Make a Fresh Start" onPress={() => nav.open('fresh-start')} /> : null}
      <View style={s.divider} />
      <MenuRow dense label="Manage Payees" onPress={() => leaveForPage(openPayees)} />
      <MenuRow
        dense
        label="Linked banks"
        onPress={() => leaveForPage(() => router.push('/connect-bank'))}
      />
      <MenuRow
        dense
        label="Export / Import"
        onPress={() => leaveForPage(() => router.push('/backup'))}
      />
      <MenuRow dense label="Edit Flags" onPress={() => nav.open('flags')} />
      <MenuRow dense label="Display Options" onPress={() => nav.open('display')} />
      <MenuRow
        dense
        label="Hide Amounts"
        onPress={() => setMasked(!masked)}
        chevron={masked ? '🔒' : undefined}
      />
      <Text style={s.rootHint}>
        {masked
          ? 'Amounts are hidden — tap again to unhide.'
          : 'Tap to mask every money value until reopened.'}
      </Text>
      {web ? <MenuRow dense label="Keyboard Shortcuts" onPress={() => nav.open('shortcuts')} /> : null}
      <MenuRow dense label="Account Settings" onPress={() => nav.open('account')} />
      <View style={s.divider} />
      {email ? (
        <Text style={s.sectionMeta} numberOfLines={1}>
          {email}
        </Text>
      ) : null}
      <MenuRow dense label="Profile" onPress={() => leaveForPage(() => router.push('/profile'))} />
      <View style={s.divider} />
      <MenuRow dense label="Log Out" chevron="" onPress={() => leaveForPage(signOutAndLeave)} />
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
      label="People"
      onPress={onPress}
      trailing={
        people.length > 0 ? (
          <AvatarStack people={people.map(toAvatarPerson)} max={4} size={22} ring={MENU_BG} style={{ marginRight: 8 }} />
        ) : undefined
      }
    />
  );
}
