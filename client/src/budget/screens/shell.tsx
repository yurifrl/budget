/**
 * Budget shell — the module's own navigation (design D2/D6/D8).
 *
 * One component tree, three layouts via `useMedia` (ui/media.ts, Tamagui's breakpoints):
 *   desktop (>1020) — persistent left rail (nav + accounts);
 *                     the bottom tab bar is hidden.
 *   tablet (801–1020) — the rail collapses into a drawer behind a ☰ button
 *                     with a scrim.
 *   phone (≤800)    — the app's own bottom tab bar (Home / Plan / Spending /
 *                     Accounts / Reflect), a ＋ FAB, and the
 *                     drawer (with Settings) reachable from ☰.
 *
 * The shared shell tab bar never renders here (these routes live outside the
 * `(tabs)` group), so only one bottom bar is ever visible. The prominent
 * control at the top of the rail / drawer opens the settings menu
 * (shell/SettingsMenu); the Budget settings are its panes
 * (budget/ui/MenuPanes) — one portal menu, nothing paints over it.
 */

import { Link, Tabs, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SettingsMenu, type MenuPane } from '@/shell/SettingsMenu';
import { MeAvatarButton } from '@/profile';
import { IconSymbol } from '@/ui/icon-symbol';
import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { useMedia } from '@/ui/media';

import { useGetAccountsQuery, useGetBudgetsQuery } from '../data/api';
import { milliToCents } from '../data/mapping';
import type { AccountRow } from '../data/rows';
import { workingBalance } from '../domain/engine';
import { useMoneyFormat, useMoneyMask } from '../model/useDisplayPrefs';
import type { Transaction } from '../domain/types';
import { restoreActiveBudget, switchBudget } from '../state/thunks';
import {
  selectActiveBudgetId,
  selectShowClosedAccounts,
} from '../state/ui';
import { personLabel } from '../domain/people';
import { useBudgetRevisionWatcher } from '../model/useBudgetRevisionWatcher';
import { usePeople } from '../model/usePeople';
import { AccountOwnerFace } from '../ui/PersonFace';
import { colors, radius } from '../ui/theme';
import { AccountEditModal } from './AccountEditModal';
import { AddAccountModal } from './AddAccountModal';
import { AddTransactionSheet } from './AddTransactionSheet';
import { budgetMenuPanes } from '../ui/MenuPanes';
import { ShellContext, type BudgetShellState } from './shellContext';

export { useBudgetShell, type BudgetShellState } from './shellContext';

const NAV_LINKS = [
  { route: '/plan', label: 'Plan', icon: 'list.bullet' },
  { route: '/reflect', label: 'Reflect', icon: 'chart.bar.fill' },
  { route: '/accounts', label: 'All Accounts', icon: 'building.columns.fill' },
] as const;

/** KVStore keys persisting the rail's collapse states (desktop) across reloads. */
const RAIL_COLLAPSED_KEY = 'budget.shell.railCollapsed';
/** Per-account-group chevron collapse (CASH/CREDIT/...), shared with the osb spec. */
const GROUP_COLLAPSED_KEY = 'budget.sidebar.collapsedAccountGroups';

/** Rail section order: CLOSED always last. */
const GROUP_ORDER: Record<string, number> = { CASH: 0, CREDIT: 1, CLOSED: 2 };

/** Display label per cash-family account type (the rail splits CASH by type). */
const TYPE_LABEL: Partial<Record<AccountRow['type'], string>> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
};

/**
 * Left rail (desktop) / drawer content (tablet & phone).
 *
 * The one navigation surface: nav links, grouped clickable accounts (the old
 * in-screen AccountsSidebar merged here), and — desktop only — a collapse
 * toggle that turns the rail into an icon strip (state persisted via KVStore).
 * `collapsed` undefined = no toggle (drawer mode).
 */
function BudgetRail({
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
  const { personOf, me } = usePeople(budgetId);
  const showClosedAccounts = useAppSelector((s) =>
    selectShowClosedAccounts(s),
  );
  const groups = useMemo(() => {
    // Cash-family accounts split per type (Checking/Savings/Cash — a raw
    // CASH bucket reads wrong when every account is checking); CREDIT and
    // CLOSED stay whole, CLOSED rendering only when the Settings toggle
    // enables it AND closed accounts exist (YNAB parity, osb).
    const all = (accounts.data ?? []).filter(
      (a) => showClosedAccounts || a.account_group !== 'CLOSED',
    );
    const sections: { key: string; label: string; accs: AccountRow[] }[] = [];
    const push = (key: string, label: string, a: AccountRow) => {
      const existing = sections.find((s) => s.key === key);
      if (existing) existing.accs.push(a);
      else sections.push({ key, label, accs: [a] });
    };
    for (const a of all) {
      if (a.account_group === 'CASH') {
        push(`CASH:${a.type}`, TYPE_LABEL[a.type] ?? 'Cash', a);
      } else {
        push(a.account_group, a.account_group === 'CREDIT' ? 'Credit Cards' : 'Closed', a);
      }
    }
    // YNAB order: cash-family sections, CREDIT, then CLOSED always last.
    return sections.sort(
      (x, y) => (GROUP_ORDER[x.key.split(':')[0]] ?? 9) - (GROUP_ORDER[y.key.split(':')[0]] ?? 9),
    );
  }, [accounts.data, showClosedAccounts]);

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
                    const groupTotal = accs.reduce(
                      (sum, a) => sum + milliToCents(a.cleared_balance) + milliToCents(a.uncleared_balance),
                      0,
                    );
                    return (
                      <Text style={[styles.acctGroupText, groupTotal < 0 && styles.acctBalanceNeg]}>
                        {formatMoney(groupTotal)}
                      </Text>
                    );
                  })()}
                </Pressable>
                {open
                  ? accs.map((a) => {
                      const bal = workingBalance({
                        clearedBalance: milliToCents(a.cleared_balance),
                        unclearedBalance: milliToCents(a.uncleared_balance),
                      } as never);
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

export function BudgetLayout() {
  const media = useMedia();
  // Same buckets as Tamagui v5's media (see ui/media.ts): min-width keys, `max-*` for max-width.
  // Buckets: phone ≤768 (`max-md`), desktop ≥1024 (lg), tablet in between.
  const isPhone = media['max-md'];
  const isDesktop = media.lg;
  const isTablet = !isPhone && !isDesktop;

  const insets = useSafeAreaInsets();
  // ☰/⋯ sit below the status bar / notch; screens pad past that whole row.
  const chromeTop = Math.max(13, insets.top + 4);
  const contentTopPad = chromeTop + 39;

  const dispatch = useAppDispatch();
  const budgetId = useAppSelector((s) => selectActiveBudgetId(s));
  const budgets = useGetBudgetsQuery();
  useBudgetRevisionWatcher(budgetId);
  const [restored, setRestored] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Desktop-only collapse of the rail to an icon strip, persisted like the
  // plan's group collapse (same KVStore service).
  const storage = useService(Tokens.Storage);
  const [railCollapsed, setRailCollapsed] = useState(false);
  useEffect(() => {
    void storage.get<boolean>(RAIL_COLLAPSED_KEY, false).then(setRailCollapsed);
  }, [storage]);
  const toggleRail = (v: boolean) => {
    setRailCollapsed(v);
    void storage.set(RAIL_COLLAPSED_KEY, v);
  };
  const panes = useMemo(() => budgetMenuPanes(budgetId), [budgetId]);
  // A screen asks for the People pane; the rail's menu (or the drawer's, on
  // tablet/phone) opens it and clears the request.
  const [menuRequest, setMenuRequest] = useState<{ paneId: string } | null>(null);
  const clearMenuRequest = useCallback(() => setMenuRequest(null), []);
  const [addTxnOpen, setAddTxnOpen] = useState(false);
  const [editTxn, setEditTxn] = useState<Transaction | null>(null);
  // Prefill for a NEW entry (mobile category detail "＋ Transaction").
  const [prefillCategoryId, setPrefillCategoryId] = useState<string | null>(null);
  /** Plan screen reports its row-tap numpad panel here; the FAB parks while
   * it's open (it otherwise covers the keypad's ✕ 0 ⌫ row). */
  const [numpadOpen, setNumpadOpen] = useState(false);
  // FAB morph: the "＋ Transaction" pill at rest; while the numpad panel is
  // open it slides down behind the tab bar, collapsing to the round ＋.
  const fabShift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fabShift, {
      toValue: numpadOpen ? 130 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [numpadOpen, fabShift]);
  // Hide Amounts banner. (Per-budget settings are rehydrated on budget
  // switch by state/budgetSettings; money renders follow through
  // useMoneyFormat.)
  const [masked, setMasked] = useMoneyMask();

  // Restore the persisted active budget, then fall back to the first budget.
  useEffect(() => {
    void dispatch(restoreActiveBudget()).finally(() => setRestored(true));
  }, [dispatch]);
  useEffect(() => {
    // A persisted id can go stale (budget deleted server-side, DB reset):
    // reconcile against the fetched list, not just absence, or every
    // budget-data write 404s with "budget not found" forever. Skips
    // archived rows: while Budgets refetches after a fresh-start the
    // not-yet-listed replacement must not be bounced back to data[0] —
    // which an archive reorder makes an archived budget.
    if (!restored || !budgets.data?.length) return;
    if (!budgetId || !budgets.data.some((b) => b.id === budgetId)) {
      void dispatch(switchBudget(budgets.data.find((b) => !b.archived_at)?.id ?? budgets.data[0].id));
    }
  }, [restored, budgetId, budgets.data, dispatch]);

  const router = useRouter();
  const shell: BudgetShellState = useMemo(
    () => ({
      isPhone,
      isTablet,
      isDesktop,
      contentTopPad,
      openAddTransaction: (prefill?: { categoryId?: string | null }) => {
        setEditTxn(null);
        setPrefillCategoryId(prefill?.categoryId ?? null);
        setAddTxnOpen(true);
      },
      openEditTransaction: (txn: Transaction) => {
        setEditTxn(txn);
        setPrefillCategoryId(null);
        setAddTxnOpen(true);
      },
      // Import and payee management are destination pages (/import,
      // /payees), not sheets.
      openImportTransactions: () => router.push('/import'),
      openPayees: () => router.push('/payees'),
      closeSidebar: () => setDrawerOpen(false),
      numpadOpen,
      setNumpadOpen,
      openPeople: () => {
        if (!isDesktop) setDrawerOpen(true);
        setMenuRequest({ paneId: 'people' });
      },
    }),
    [isPhone, isTablet, isDesktop, contentTopPad, router, numpadOpen],
  );

  return (
    <ShellContext.Provider value={shell}>
      <View style={styles.root}>
        {isDesktop ? (
          <BudgetRail
            onNavigate={() => {}}
            secondary={panes}
            openRequest={menuRequest}
            onOpenRequestHandled={clearMenuRequest}
            collapsed={railCollapsed}
            onSetCollapsed={toggleRail}
          />
        ) : null}
        <View style={{ flex: 1 }}>
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
              name="index"
              options={{
                title: 'Home',
                tabBarIcon: ({ color }) => <IconSymbol size={22} name="house.fill" color={color} />,
              }}
            />
            <Tabs.Screen
              name="plan"
              options={{
                title: 'Plan',
                tabBarIcon: ({ color }) => <IconSymbol size={22} name="list.bullet" color={color} />,
              }}
            />
            <Tabs.Screen
              name="spending"
              options={{
                title: 'Spending',
                tabBarIcon: ({ color }) => <IconSymbol size={22} name="creditcard.fill" color={color} />,
              }}
            />
            <Tabs.Screen
              name="accounts"
              options={{
                title: 'Accounts',
                tabBarIcon: ({ color }) => (
                  <IconSymbol size={22} name="building.columns.fill" color={color} />
                ),
              }}
            />
            <Tabs.Screen
              name="reflect"
              options={{
                title: 'Reflect',
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
            {/* Linked-account detail: pushed with ?account=<id>, never a tab. */}
            <Tabs.Screen
              name="linked-account"
              options={{
                tabBarButton: () => null,
                tabBarItemStyle: { display: 'none' },
              }}
            />
          </Tabs>
        </View>

        {/* Tablet/phone chrome: ☰ opens the rail drawer (Settings lives there). */}
        {!isDesktop ? (
          <>
            <Pressable
              style={[styles.chromeBtn, { left: 14, top: chromeTop }]}
              onPress={() => setDrawerOpen(true)}
              accessibilityLabel="Menu">
              <Text style={styles.chromeBtnText}>☰</Text>
            </Pressable>
          </>
        ) : null}
        {!isDesktop && drawerOpen ? (
          <>
            <Pressable style={styles.scrim} onPress={() => setDrawerOpen(false)} />
            <View style={styles.drawer}>
              <BudgetRail
                topInset={insets.top}
                bottomInset={Math.max(13, insets.bottom)}
                onNavigate={() => setDrawerOpen(false)}
                secondary={panes}
                openRequest={menuRequest}
                onOpenRequestHandled={clearMenuRequest}
              />
            </View>
          </>
        ) : null}

        {/* Phone: ＋ Transaction FAB above the tab bar. While the plan screen's
        numpad panel is open it slides down out of the keypad's corner and
        collapses to the round ＋ — mounted the whole time, slides back up as
        the pill on close. */}
        {isPhone ? (
          <Animated.View style={[styles.fab, { transform: [{ translateY: fabShift }] }]}>
            <Pressable
              style={[styles.fabPill, numpadOpen && styles.fabPillParked]}
              onPress={() => {
                setEditTxn(null);
                setPrefillCategoryId(null);
                setAddTxnOpen(true);
              }}
              accessibilityLabel="New transaction">
              {numpadOpen ? (
                <Text style={styles.fabGlyph}>＋</Text>
              ) : (
                <Text style={styles.fabText}>＋ Transaction</Text>
              )}
            </Pressable>
          </Animated.View>
        ) : null}

        {/* Hide Amounts sticky banner — session-scoped, tap to unhide. */}
        {masked ? (
          <Pressable
            style={styles.maskBanner}
            onPress={() => setMasked(false)}
            accessibilityRole="button"
            accessibilityLabel="Unhide amounts">
            <Text style={styles.maskBannerText}>🔒 Amounts are hidden — tap to unhide</Text>
          </Pressable>
        ) : null}

        <AddTransactionSheet
          key={editTxn ? `edit-${editTxn.id}` : `new-${prefillCategoryId ?? ''}`}
          visible={addTxnOpen}
          editTxn={editTxn}
          prefillCategoryId={prefillCategoryId}
          onClose={() => {
            setAddTxnOpen(false);
            setEditTxn(null);
            setPrefillCategoryId(null);
          }}
        />
      </View>
    </ShellContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: colors.bg },
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
  maskBanner: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    zIndex: 50,
    alignItems: 'center',
    paddingVertical: 8,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  maskBannerText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
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
  nav: { marginTop: 14, gap: 2 },
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
  chromeBtn: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 30,
  },
  chromeBtnText: { color: colors.muted, fontSize: 15 },
  scrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,.55)',
    zIndex: 40,
  },
  drawer: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    zIndex: 41,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 20,
  },
  fab: { position: 'absolute', right: 14, bottom: 76, zIndex: 18 },
  fabPill: {
    alignItems: 'center',
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.pill,
    paddingVertical: 12,
    paddingHorizontal: 17,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 15,
  },
  /** The round ＋ the pill collapses into while pushed down. */
  fabPillParked: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  fabText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  fabGlyph: { color: colors.text, fontSize: 26, fontWeight: '600', marginTop: -2 },
});
