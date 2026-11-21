import { Image } from 'expo-image';
import { Link, usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useGetBudgetsQuery } from '@/budget/data/api';
import { useMe } from '@/features/profile';
import { displayName } from '@/profile/model';
import { useAppSelector } from '@/state/hooks';
import { selectActiveBudgetId } from '@/state/ui';
import { Avatar } from '@/ui/avatar/Avatar';
import { IconSymbol } from '@/ui/icon-symbol';
import { colors, radius } from '@/ui/theme';

import logo from '../../../assets/images/logo.png';
import { t } from '../i18n';
import { SettingsMenu, type MenuPane } from '../SettingsMenu';
import { RailAccounts } from './RailAccounts';

// eslint-disable-next-line budget-i18n/no-untranslated-string -- brand name, not translated
const APP_TITLE = 'Budget';

/** Built per render: the labels follow the active language. */
const navLinks = () =>
  [
    { route: '/plan', label: t('rail.plan'), icon: 'list.bullet' },
    { route: '/reflect', label: t('rail.reflect'), icon: 'chart.bar.fill' },
    { route: '/accounts', label: t('rail.allAccounts'), icon: 'building.columns.fill' },
  ] as const;

/**
 * Left rail (desktop) / drawer content (tablet & phone), top to bottom:
 * the app title (logo + name) with the collapse-sidebar button, the nav
 * links, the account groups, and pinned at the bottom the account row (my
 * avatar, my name, the current budget) that opens the settings menu upward.
 *
 * Desktop only: the collapse button turns the rail into an icon strip (state
 * persisted by the host). `collapsed` undefined = no button (drawer mode).
 */
export function BudgetRail({
  onNavigate,
  secondary,
  collapsed,
  onSetCollapsed,
  topInset = 0,
  bottomInset = 0,
  openRequest,
  onOpenRequestHandled,
}: {
  onNavigate: () => void;
  openRequest?: { paneId: string } | null;
  onOpenRequestHandled?: () => void;
  /** Panes for the settings menu (budget settings). */
  secondary: MenuPane[];
  collapsed?: boolean;
  onSetCollapsed?: (v: boolean) => void;
  /** Extra top padding in drawer mode so the title clears the status bar. */
  topInset?: number;
  /** Extra bottom padding in drawer mode so the account row clears the home indicator. */
  bottomInset?: number;
}) {
  const pathname = usePathname();
  const budgetId = useAppSelector((s) => selectActiveBudgetId(s));
  const budgetName = useGetBudgetsQuery().data?.find((b) => b.id === budgetId)?.name;
  const isCollapsed = collapsed === true;

  return (
    <View style={[styles.rail, { paddingTop: 13 + topInset }, isCollapsed && styles.railCollapsed]}>
      <View style={[styles.head, isCollapsed && styles.headCollapsed]}>
        <View style={styles.brand}>
          <Image source={logo} accessibilityLabel={APP_TITLE} style={styles.logo} />
          {isCollapsed ? null : (
            <Text style={styles.title} numberOfLines={1}>
              {APP_TITLE}
            </Text>
          )}
        </View>
        {collapsed != null ? (
          <Pressable
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
            onPress={() => onSetCollapsed?.(!collapsed)}
            accessibilityRole="button"
            accessibilityLabel={collapsed ? t('rail.expand') : t('rail.collapse')}>
            <IconSymbol size={18} name="sidebar.left" color={colors.muted} style={SIDEBAR_ICON_FLIP} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.nav}>
        {navLinks().map((l) => {
          const active = pathname.startsWith(l.route);
          return (
            <Link key={l.route} href={l.route} onPress={() => onNavigate()} accessibilityLabel={l.label} asChild>
              <Pressable
                // expo-router's Slot (asChild) rejects style arrays.
                style={StyleSheet.flatten([styles.navLink, isCollapsed && styles.navLinkIcon, active && styles.navLinkActive])}>
                <IconSymbol size={isCollapsed ? 20 : 17} name={l.icon} color={active ? colors.text : colors.muted} />
                {isCollapsed ? null : (
                  <Text style={[styles.navLinkText, active && { color: colors.text }]} numberOfLines={1}>
                    {l.label}
                  </Text>
                )}
              </Pressable>
            </Link>
          );
        })}
      </View>
      {isCollapsed ? <View style={{ flex: 1 }} /> : <RailAccounts budgetId={budgetId} onNavigate={onNavigate} />}
      <View style={[styles.foot, { paddingBottom: bottomInset }]}>
        <SettingsMenu
          panes={secondary}
          topInset={topInset}
          openRequest={openRequest}
          onOpenRequestHandled={onOpenRequestHandled}
          trigger={(open) => <AccountTrigger open={open} compact={isCollapsed} budgetName={budgetName} />}
        />
      </View>
    </View>
  );
}

/** The account row: who is signed in and which budget is open. */
function AccountTrigger({ open, compact, budgetName }: { open: boolean; compact: boolean; budgetName?: string }) {
  const { me } = useMe();
  const avatar = me ? <Avatar person={me} size={30} /> : <View style={styles.avatarBlank} />;
  if (compact) return <View style={[styles.triggerCompact, open && styles.pressed]}>{avatar}</View>;
  return (
    <View style={[styles.trigger, open && styles.pressed]}>
      {avatar}
      <View style={styles.triggerText}>
        <Text style={styles.triggerName} numberOfLines={1}>
          {me ? displayName(me) : ' '}
        </Text>
        <Text style={styles.triggerBudget} numberOfLines={1}>
          {budgetName ?? APP_TITLE}
        </Text>
      </View>
      <IconSymbol size={16} name="chevron.up.chevron.down" color={colors.faint} />
    </View>
  );
}

/** Material's view-sidebar draws the panel on the right; the rail is on the left (no-op on iOS's sidebar.left). */
const SIDEBAR_ICON_FLIP = process.env.EXPO_OS === 'ios' ? undefined : { transform: [{ scaleX: -1 }] };

const styles = StyleSheet.create({
  rail: {
    width: 236,
    height: '100%',
    backgroundColor: colors.railBg,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingVertical: 13,
    paddingHorizontal: 11,
    gap: 4,
  },
  railCollapsed: { width: 64, paddingHorizontal: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 34, paddingLeft: 8 },
  headCollapsed: { flexDirection: 'column', justifyContent: 'flex-start', gap: 8, paddingLeft: 0 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1, minWidth: 0 },
  logo: { width: 28, height: 28, borderRadius: 8 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  iconBtn: { width: 30, height: 30, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: colors.hover },
  nav: { marginTop: 12, gap: 2 },
  navLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
  },
  navLinkIcon: { justifyContent: 'center', paddingHorizontal: 0 },
  navLinkActive: { backgroundColor: colors.indigoSoft },
  navLinkText: { color: colors.muted, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  foot: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8 },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: radius.sm,
  },
  triggerCompact: { alignItems: 'center', justifyContent: 'center', paddingVertical: 7, borderRadius: radius.sm },
  triggerText: { flex: 1, minWidth: 0 },
  triggerName: { color: colors.text, fontSize: 13, fontWeight: '600' },
  triggerBudget: { color: colors.faint, fontSize: 12, marginTop: 1 },
  avatarBlank: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.card2 },
});
