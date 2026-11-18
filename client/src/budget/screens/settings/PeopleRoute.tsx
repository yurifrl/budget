import { useRouter } from 'expo-router';

import { useMenuNav } from '@/shell/SettingsMenu';

import { PeoplePane } from '../../ui/PeoplePane';
import { useBudgetShell } from '../shellContext';

/** People pane bound to the menu: "Edit profile" leaves every layer of chrome for /profile. */
export function PeopleRoute({ budgetId }: { budgetId: string | null }) {
  const nav = useMenuNav();
  const router = useRouter();
  const { closeSidebar } = useBudgetShell();
  return (
    <PeoplePane
      budgetId={budgetId}
      onOpenProfile={() => {
        nav.close();
        closeSidebar();
        router.push('/profile');
      }}
    />
  );
}
