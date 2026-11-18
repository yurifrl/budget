import { useRouter } from 'expo-router';
import { Text } from 'react-native';

import { useMenuNav } from '@/shell/menuNav';
import { useAppSelector } from '@/state/hooks';
import { AvatarStack } from '@/ui/avatar/AvatarStack';

import { toAvatarPerson } from '@/domain/people';
import { useMoneyMask } from '@/state/useDisplayPrefs';
import { useGetBudgetsQuery } from '@/budget/data/api';
import { usePeople } from '@/features/people';
import { selectActiveBudgetId } from '@/state/ui';
import { useBudgetShell } from '@/shell/context';
import { MenuRow } from './menuRows';
import { canManageBudget } from './settings.logic';
import { MENU_BG, s } from './styles';

/** Root menu — the two sections from the validated mock. */
export function SettingsRootPane() {
  const nav = useMenuNav();
  const router = useRouter();
  const { openPayees, closeSidebar } = useBudgetShell();
  const [masked, setMasked] = useMoneyMask();
  const web = process.env.EXPO_OS === 'web';
  const activeBudgetId = useAppSelector((st) => selectActiveBudgetId(st));
  const isOwner = canManageBudget(useGetBudgetsQuery().data?.find((b) => b.id === activeBudgetId));
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
      <Text style={s.sectionLabel}>BUDGET</Text>
      <MenuRow label="Open Budget" onPress={() => nav.open('open')} />
      <MenuRow label="New Budget" onPress={() => nav.open('new')} />
      <MenuRow label="Plan Settings" onPress={() => nav.open('settings')} />
      <PeopleMenuRow onPress={() => nav.open('people')} />
      {isOwner ? <MenuRow label="Make a Fresh Start" onPress={() => nav.open('fresh-start')} /> : null}
      <Text style={s.sectionLabel}>MANAGE</Text>
      <MenuRow label="Manage Payees" onPress={() => leaveForPage(openPayees)} />
      <MenuRow
        label="Linked banks"
        onPress={() => leaveForPage(() => router.push('/connect-bank'))}
      />
      <MenuRow
        label="Export / Import"
        onPress={() => leaveForPage(() => router.push('/backup'))}
      />
      <MenuRow label="Edit Flags" onPress={() => nav.open('flags')} />
      <MenuRow label="Display Options" onPress={() => nav.open('display')} />
      <MenuRow
        label="Hide Amounts"
        onPress={() => setMasked(!masked)}
        chevron={masked ? '🔒' : undefined}
      />
      {web ? <MenuRow label="Keyboard Shortcuts" onPress={() => nav.open('shortcuts')} /> : null}
      <MenuRow label="Account Settings" onPress={() => nav.open('account')} />
      <Text style={s.hint}>
        {masked
          ? 'Amounts are hidden — tap again to unhide.'
          : 'Tap to mask every money value until reopened.'}
      </Text>
    </>
  );
}

/** Settings "People" row with an at-a-glance stack of who the budget is shared with. */
function PeopleMenuRow({ onPress }: { onPress: () => void }) {
  const budgetId = useAppSelector((st) => selectActiveBudgetId(st));
  const { people } = usePeople(budgetId);
  return (
    <MenuRow
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
