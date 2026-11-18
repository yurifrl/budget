import { Link, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { MeAvatarButton } from '@/features/profile';
import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { SettingsMenu, type MenuPane } from '../SettingsMenu';
import { useAppSelector } from '@/state/hooks';
import { IconSymbol } from '@/ui/icon-symbol';

import { useGetAccountsQuery, useGetBudgetsQuery } from '@/budget/data/api';
import type { AccountRow } from '@/budget/data/rows';
import { personLabel } from '@/domain/people';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { usePeople } from '@/features/people';
import { selectActiveBudgetId, selectShowClosedAccounts } from '@/state/ui';
import { AccountOwnerFace } from '@/ui/PersonFace';
import { colors, radius } from '@/ui/theme';
import { AccountEditModal , AddAccountModal } from '@/features/accounts';
import { railAccountBalance, railSections, railSectionTotal } from './rail.logic';

const NAV_LINKS = [
  { route: '/plan', label: 'Plan', icon: 'list.bullet' },
  { route: '/reflect', label: 'Reflect', icon: 'chart.bar.fill' },
  { route: '/accounts', label: 'All Accounts', icon: 'building.columns.fill' },
] as const;

/** Per-account-group chevron collapse (CASH/CREDIT/...), shared with the osb spec. */
const GROUP_COLLAPSED_KEY = 'budget.sidebar.collapsedAccountGroups';

/**
 * Left rail (desktop) / drawer content (tablet & phone).
 *
 * The one navigation surface: nav links, grouped clickable accounts (the old
 * in-screen AccountsSidebar merged here), and — desktop only — a collapse
 * toggle that turns the rail into an icon strip (state persisted via KVStore).
 * `collapsed` undefined = no toggle (drawer mode).
 */
export function BudgetRail({
  onNavigate,
  onGoHome,
  secondary,
  collapsed,
  onSetCollapsed,
  topInset = 0,
  bottomInset = 0,
  openRequest,
  onOpenRequestHandled,
}: {
  onNavigate: () => void;
  /** Leave the budget for the home page (all budgets). */
  onGoHome: () => void;
  openRequest?: { paneId: string } | null;
  onOpenRequestHandled?: () => void;
  /** Panes for the settings menu (budget settings). */
  secondary: MenuPane[];
  collapsed?: boolean;
  onSetCollapsed?: (v: boolean) => void;
  /** Extra top padding in drawer mode so the menu pill clears the status bar. */
  topInset?: number;
  /** Extra bottom padding in drawer mode so the footer clears the home indicator. */
  bottomInset?: number;
}) {
  const { formatMoney } = useMoneyFormat();
  const router = useRouter();
  const pathname = usePathname();
  // Account selection lives in the URL (?account=) so the register on
  // /accounts can react to rail picks from any tab.
  // Global, not local: the rail mounts in the Tabs layout (parent route) and
  // expo-router's useLocalSearchParams there doesn't see child-screen query
  // params (?account=<id> on /accounts) — useGlobalSearchParams does.
  const { account: accountParam } = useGlobalSearchParams<{ account?: string }>();
  const storage = useService(Tokens.Storage);
  const [groupCollapsed, setGroupCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void storage.get<Record<string, boolean>>(GROUP_COLLAPSED_KEY, {}).then(setGroupCollapsed);
  }, [storage]);
  const toggleGroup = (group: string) => {
    setGroupCollapsed((prev) => {
      const next = { ...prev, [group]: !prev[group] };
      void storage.set(GROUP_COLLAPSED_KEY, next);
      return next;
    });
  };

  const budgetId = useAppSelector((s) => selectActiveBudgetId(s));
  const accounts = useGetAccountsQuery(budgetId ? { budgetId } : { budgetId: '' }, { skip: !budgetId });
  const budgetName = useGetBudgetsQuery().data?.find((b) => b.id === budgetId)?.name;
  const { personOf, me } = usePeople(budgetId);
  const showClosedAccounts = useAppSelector((s) =>
    selectShowClosedAccounts(s),
  );
  const groups = useMemo(() => railSections(accounts.data ?? [], showClosedAccounts), [accounts.data, showClosedAccounts]);

  const selectAccount = (id: string | null) => {
    router.navigate({ pathname: '/accounts', params: id ? { account: id } : {} } as never);
    onNavigate();
  };

  // YNAB parity: right-click (web) / long-press (native) an account row → Edit
  // Account; a + Add Account button sits under the last group.
  const [editAccount, setEditAccount] = useState<AccountRow | null>(null);
  const [addAccountOpen, setAddAccountOpen] = useState(false);

  const isCollapsed = collapsed === true;

  return (
    <View style={[styles.rail, { paddingTop: 13 + topInset }, isCollapsed && styles.railCollapsed]}>
      {/* The PROMINENT control: the settings-menu trigger with the rail's
          ⚙ beside/under it; budget settings ride inside the menu as panes. */}
      <View style={[styles.switchRow, isCollapsed && styles.switchRowCollapsed]}>
        <SettingsMenu
          compact={isCollapsed}
          panes={secondary}
          openRequest={openRequest}
          onOpenRequestHandled={onOpenRequestHandled}
        />
      </View>
      <Pressable
        onPress={onGoHome}
        accessibilityRole="button"
        accessibilityLabel="All budgets"
        style={({ pressed }) => [styles.homeLink, isCollapsed && styles.navLinkIcon, pressed && styles.homeLinkPressed]}>
        <IconSymbol size={isCollapsed ? 20 : 15} name="house.fill" color={colors.muted} />
        {isCollapsed ? null : (
          <View style={styles.homeLinkText}>
            <Text style={styles.homeLinkKicker}>ALL BUDGETS</Text>
            <Text style={styles.homeLinkName} numberOfLines={1}>
              {budgetName ?? 'Budget'}
            </Text>
          </View>
        )}
      </Pressable>
      <View style={styles.nav}>
        {NAV_LINKS.map((l) => {
          const active = pathname.startsWith(l.route);
          return (
            <Link
              key={l.route}
              href={l.route}
              onPress={() => onNavigate()}
              style={[styles.navLink, isCollapsed && styles.navLinkIcon, active && styles.navLinkActive]}
              accessibilityLabel={l.label}>
              {isCollapsed ? (
                <IconSymbol size={20} name={l.icon} color={active ? colors.text : colors.muted} />
              ) : (
                <Text style={[styles.navLinkText, active && { color: colors.text }]}>{l.label}</Text>
              )}
            </Link>
          );
        })}
      </View>
      {isCollapsed ? (
        <View style={{ flex: 1 }} />
      ) : (
        <ScrollView style={styles.accts}>
          {groups.map(({ key, label, accs }) => {
            const open = !groupCollapsed[key];
            return (
              <View key={key}>
                <Pressable style={styles.acctGroupRow} onPress={() => toggleGroup(key)}>
                  <Text style={styles.acctGroupText}>{open ? '▾' : '▸'}</Text>
                  <Text style={[styles.acctGroupText, { flex: 1 }]}>{label}</Text>
                  {(() => {
                    const groupTotal = railSectionTotal(accs);
                    return (
                      <Text style={[styles.acctGroupText, groupTotal < 0 && styles.acctBalanceNeg]}>
                        {formatMoney(groupTotal)}
                      </Text>
                    );
                  })()}
                </Pressable>
                {open
                  ? accs.map((a) => {
                      const bal = railAccountBalance(a);
                      return (
                        <Pressable
                          key={a.id}
                          onPress={() => selectAccount(a.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setEditAccount(a);
                          }}
                          onLongPress={() => setEditAccount(a)}
                          accessibilityLabel={`Open account ${a.name}`}
                          style={[styles.acctRow, accountParam === a.id && styles.acctRowSelected]}>
                          <View style={styles.acctNameCol}>
                            <Text style={styles.acctName} numberOfLines={1}>
                              {a.name}
                            </Text>
                          </View>
                          <AccountOwnerFace person={personOf(a.user_id)} />
                          <Text style={[styles.acctBalance, bal < 0 && styles.acctBalanceNeg]}>
                            {formatMoney(bal)}
                          </Text>
                        </Pressable>
                      );
                    })
                  : null}
              </View>
            );
          })}
          <Pressable
            style={styles.addAccountBtn}
            onPress={() => setAddAccountOpen(true)}
            accessibilityLabel="Add Account">
            <Text style={styles.addAccountText}>＋ Add Account</Text>
          </Pressable>
        </ScrollView>
      )}
      <View style={[styles.railFoot, { paddingBottom: bottomInset }, isCollapsed && styles.railFootCenter]}>
        {editAccount && budgetId ? (
          <AccountEditModal account={editAccount} budgetId={budgetId} onClose={() => setEditAccount(null)} />
        ) : null}
        {addAccountOpen && budgetId ? (
          <AddAccountModal budgetId={budgetId} visible onClose={() => setAddAccountOpen(false)} />
        ) : null}
        {/* Profile entry: the viewer's avatar + name (the rail is also the tablet/phone drawer). */}
        <View style={isCollapsed ? undefined : styles.footMe}>
          <MeAvatarButton size={isCollapsed ? 24 : 28} />
          {isCollapsed || !me ? null : (
            <Text style={styles.footMeName} numberOfLines={1}>
              {personLabel(me)}
            </Text>
          )}
        </View>
        {collapsed != null ? (
          <Pressable
            style={[styles.railFootToggle, isCollapsed && styles.railFootToggleIcon]}
            onPress={() => onSetCollapsed?.(!collapsed)}
            accessibilityLabel={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <IconSymbol size={18} name={collapsed ? 'chevron.right' : 'chevron.left'} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  footMe: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  footMeName: { color: colors.muted, fontSize: 12, fontWeight: '600', flexShrink: 1 },
  switchRowCollapsed: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
  },
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
  homeLink: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  homeLinkPressed: { backgroundColor: colors.hover },
  homeLinkText: { flex: 1, minWidth: 0 },
  homeLinkKicker: { color: colors.faint, fontSize: 9, fontWeight: '700', letterSpacing: 1.2 },
  homeLinkName: { color: colors.text, fontSize: 13, fontWeight: '600' },
  nav: { marginTop: 8, gap: 2 },
  navLink: { paddingVertical: 9, paddingHorizontal: 12, borderRadius: radius.sm },
  navLinkActive: { backgroundColor: colors.indigoSoft },
  navLinkText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  accts: { marginTop: 16, flex: 1 },
  acctGroupRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  acctGroupText: {
    color: colors.faint,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  acctRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 6,
    gap: 8,
  },
  acctName: { color: colors.text, fontSize: 13, flex: 1 },
  acctNameCol: { flex: 1, gap: 1 },
  acctBalance: { color: colors.greenPillFg, fontSize: 13, fontVariant: ['tabular-nums'] },
  acctBalanceNeg: { color: colors.redFg },
  addAccountBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  addAccountText: { color: colors.indigo3, fontSize: 13, fontWeight: '600' },
  railCollapsed: { width: 64, paddingHorizontal: 8 },
  navLinkIcon: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 0 },
  acctRowSelected: { backgroundColor: colors.indigo2 + '2e' },
  railFoot: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  railFootCenter: { justifyContent: 'center', gap: 2 },
  railFootToggle: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  railFootToggleIcon: { width: 22 },
});
