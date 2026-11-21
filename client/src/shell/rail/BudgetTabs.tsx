import { Tabs } from 'expo-router';

import { IconSymbol } from '@/ui/icon-symbol';

import { colors } from '@/ui/theme';

import { t } from '../i18n';

/**
 * The budget routes as tabs. The bar itself shows on the phone only (desktop
 * and tablet navigate through the rail / drawer).
 */
export function BudgetTabs({ isPhone }: { isPhone: boolean }) {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.indigo2,
        tabBarInactiveTintColor: colors.faint,
        tabBarStyle: isPhone
          ? {
              backgroundColor: 'rgba(10,12,18,.96)',
              borderTopColor: colors.border,
              borderTopWidth: 1,
            }
          : { display: 'none' },
      }}>
      <Tabs.Screen
        name="overview"
        options={{
          title: t('tabs.overview'),
          tabBarIcon: ({ color }) => <IconSymbol size={22} name="square.grid.2x2.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="plan"
        options={{
          title: t('tabs.plan'),
          tabBarIcon: ({ color }) => <IconSymbol size={22} name="list.bullet" color={color} />,
        }}
      />
      <Tabs.Screen
        name="spending"
        options={{
          title: t('tabs.spending'),
          tabBarIcon: ({ color }) => <IconSymbol size={22} name="creditcard.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="accounts"
        options={{
          title: t('tabs.accounts'),
          tabBarIcon: ({ color }) => (
            <IconSymbol size={22} name="building.columns.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="reflect"
        options={{
          title: t('tabs.reflect'),
          tabBarIcon: ({ color }) => <IconSymbol size={22} name="chart.bar.fill" color={color} />,
        }}
      />
      {/* Import is a destination page, not a tab. SDK 58 makes `href: null`
          screens unreachable (focused hidden tabs redirect to the first
          visible tab), so these stay registered but render no tab button;
          on the phone bar their slots also collapse to zero width. */}
      <Tabs.Screen
        name="import"
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: 'none' },
        }}
      />
      <Tabs.Screen
        name="backup"
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: 'none' },
        }}
      />
      <Tabs.Screen
        name="payees"
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: 'none' },
        }}
      />
      <Tabs.Screen
        name="connect-bank"
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: 'none' },
        }}
      />
      {/* Per-bank settings: pushed with ?id=<connectionId>, never a tab. */}
      <Tabs.Screen
        name="connection"
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: 'none' },
        }}
      />
      {/* Own Pluggy keys: opened from Linked banks / a paused bank, never a tab. */}
      <Tabs.Screen
        name="pluggy-keys"
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: 'none' },
        }}
      />
      {/* Linked-account detail: pushed with ?account=<id>, never a tab. */}
      <Tabs.Screen
        name="linked-account"
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: 'none' },
        }}
      />
    </Tabs>
  );
}
