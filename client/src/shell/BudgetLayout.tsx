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
 * `(tabs)` group), so only one bottom bar is ever visible. The account row
 * pinned to the bottom of the rail / drawer opens the settings menu upward
 * (shell/SettingsMenu); the Budget settings are its panes
 * (features/settings) — one portal menu, nothing paints over it.
 */

import { Redirect, usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { useAppDispatch, useAppSelector } from '@/state/hooks';
import { useMedia } from '@/ui/media';

import { useGetBudgetsQuery } from '@/budget/data/api';
import { useMoneyMask } from '@/state/useDisplayPrefs';
import type { Transaction } from '@/domain/types';
import { clearActiveBudget, restoreActiveBudget } from '@/state/thunks';
import { selectActiveBudgetId } from '@/state/ui';
import { useBudgetRevisionWatcher } from '@/state/useBudgetRevisionWatcher';
import { colors, radius } from '@/ui/theme';
import { AddTransactionSheet } from '@/features/accounts';
import { CategorizeLeavePrompt } from '@/features/categorize';
import { budgetMenuPanes } from '@/features/settings';
import { t } from './i18n';
import { BudgetRail } from './rail/BudgetRail';
import { BudgetTabs } from './rail/BudgetTabs';
import { shellGate, showsTransactionFab } from './rail/rail.logic';
import { IconSymbol } from '@/ui/icon-symbol';
import { ShellContext, type BudgetShellState } from './context';

export { useBudgetShell, type BudgetShellState } from './context';

/** The home page (my budgets / shared with me), outside the budget rail. */
const HOME_HREF = '/';

/** KVStore keys persisting the rail's collapse states (desktop) across reloads. */
const RAIL_COLLAPSED_KEY = 'budget.shell.railCollapsed';

/**
 * The `(budget)` group's layout: the shell, once there is a budget to show.
 * Which budget is active is chosen on the home page (`/`) and persisted; a
 * reload or deep link inside a budget restores it here. With none (first
 * visit, zero budgets, a stale id) the person is sent home; the shell never
 * picks a budget by itself.
 */
export function BudgetLayout() {
  const dispatch = useAppDispatch();
  const budgetId = useAppSelector((s) => selectActiveBudgetId(s));
  const budgets = useGetBudgetsQuery();
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    void dispatch(restoreActiveBudget()).finally(() => setRestored(true));
  }, [dispatch]);
  const gate = shellGate({
    restored,
    activeId: budgetId,
    budgets: budgets.data,
    isFetching: budgets.isFetching,
    isError: budgets.isError,
  });
  // A stale id (budget deleted, access removed, another person on this
  // device) must not resurrect on the next launch. Kept when the list merely
  // failed to load: that says nothing about the budget.
  const stale = gate === 'home' && !!budgetId && budgets.data !== undefined;
  useEffect(() => {
    if (stale) void dispatch(clearActiveBudget());
  }, [stale, dispatch]);

  if (gate === 'home') return <Redirect href={HOME_HREF} />;
  if (gate === 'loading' || !budgetId) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.muted} />
      </View>
    );
  }
  return <BudgetShell budgetId={budgetId} />;
}

function BudgetShell({ budgetId }: { budgetId: string }) {
  const media = useMedia();
  // Same buckets as Tamagui v5's media (see ui/media.ts): min-width keys, `max-*` for max-width.
  // Buckets: phone ≤768 (`max-md`), desktop ≥1024 (lg), tablet in between.
  const isPhone = media['max-md'];
  const isDesktop = media.lg;
  const isTablet = !isPhone && !isDesktop;
  const pathname = usePathname();

  const insets = useSafeAreaInsets();
  // ☰/⋯ sit below the status bar / notch; screens pad past that whole row.
  const chromeTop = Math.max(13, insets.top + 4);
  const contentTopPad = chromeTop + 39;

  useBudgetRevisionWatcher(budgetId);
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

  const router = useRouter();
  // The one-tap way back to the home page (all budgets): pops to it when the
  // budget was opened from there, replaces this screen after a deep link.
  const goHome = useCallback(() => router.dismissTo(HOME_HREF), [router]);
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
      goHome,
      closeSidebar: () => setDrawerOpen(false),
      numpadOpen,
      setNumpadOpen,
      openPeople: () => {
        if (!isDesktop) setDrawerOpen(true);
        setMenuRequest({ paneId: 'people' });
      },
    }),
    [isPhone, isTablet, isDesktop, contentTopPad, router, goHome, numpadOpen],
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
          <BudgetTabs isPhone={isPhone} />
        </View>

        {/* Asks what to do with rows left in the Categorize strip when its page goes away. */}
        <CategorizeLeavePrompt />

        {/* Tablet/phone chrome: ☰ opens the rail drawer (Settings lives there). */}
        {!isDesktop ? (
          <>
            <Pressable
              style={[styles.chromeBtn, { left: 14, top: chromeTop }]}
              onPress={() => setDrawerOpen(true)}
              accessibilityLabel={t('layout.menu')}>
              <Text style={styles.chromeBtnText}>☰</Text>
            </Pressable>
            <Pressable
              style={[styles.chromeBtn, { left: 56, top: chromeTop }]}
              onPress={goHome}
              accessibilityRole="button"
              accessibilityLabel={t('layout.allBudgets')}>
              <IconSymbol size={17} name="house.fill" color={colors.muted} />
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
        {isPhone && showsTransactionFab(pathname) ? (
          <Animated.View style={[styles.fab, { transform: [{ translateY: fabShift }] }]}>
            <Pressable
              style={[styles.fabPill, numpadOpen && styles.fabPillParked]}
              onPress={() => {
                setEditTxn(null);
                setPrefillCategoryId(null);
                setAddTxnOpen(true);
              }}
              accessibilityLabel={t('layout.newTransaction')}>
              {numpadOpen ? (
                <Text style={styles.fabGlyph}>＋</Text>
              ) : (
                <Text style={styles.fabText}>{t('layout.fabPill')}</Text>
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
            accessibilityLabel={t('layout.unhideAmounts')}>
            <Text style={styles.maskBannerText}>{t('layout.amountsHidden')}</Text>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  root: { flex: 1, flexDirection: 'row', backgroundColor: colors.bg },
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
    shadowColor: colors.black,
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
    shadowColor: colors.black,
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
