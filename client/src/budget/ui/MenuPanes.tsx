/**
 * Budget settings panes for the settings menu (SHARED CONTRACT with
 * shell/SettingsMenu): the menu owns the surface (an RN Modal
 * portal — nothing can paint over it) and the pane stack; this file owns the
 * Budget panes rendered inside it. ONE menu, one palette — the panes reuse
 * the switcher's colors (#161a24 bg, #333c50 border, #eef1f7 text, #211d3b
 * active) instead of a second floating panel (the deleted SettingsPanel).
 *
 * Panes: root (SETTINGS) → open / new / people (sharing) / settings (plan name + format prefs
 * with live preview) / flags (6 fixed colors, editable labels — YNAB parity)
 * / display / shortcuts (web only) / account. Settings of the ACTIVE budget
 * are budgetUi actions, persisted per budget by state/budgetSettings; the
 * Hide Amounts mask is session-scoped by design (task 3.4).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useMenuNav, type MenuPane } from '@/shell/SettingsMenu';
import { AvatarStack } from '@/ui/avatar/AvatarStack';
import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { useAppDispatch, useAppSelector } from '@/store/hooks';

import {
  budgetApi,
  useArchiveBudgetMutation,
  useCreateBudgetMutation,
  useDeleteBudgetMutation,
  useFreshStartBudgetMutation,
  useGetBudgetsQuery,
  useGetMeQuery,
  useRenameBudgetMutation,
  useUnarchiveBudgetMutation,
} from '../data/api';
import { loadBudgetSettings, saveBudgetSettingsPatch } from '../data/settingsBlob';
import { defaultFlagLabel } from '../domain/flagLabels';
import { formatDateWith, formatMoneyWith } from '../domain/format';
import {
  DEFAULT_FMT_PREFS,
  type FmtCurrency,
  type FmtDateFormat,
  type FmtNumberLocale,
  type FmtPlacement,
  type FmtPrefs,
} from '../domain/fmtPrefs';
import { clearActiveBudget, switchBudget } from '../state/thunks';
import {
  selectActiveBudgetId,
  selectShowClosedAccounts,
  selectShowHiddenCategories,
  selectShowProgressBars,
  setFlagLabel,
  setFmtPrefs,
  setShowClosedAccounts,
  setShowHiddenCategories,
  setShowProgressBars,
} from '../state/ui';
import { useBudgetShell } from '../screens/shell';
import { OverlaySheet } from './bits';
import { PeoplePane } from './PeoplePane';
import { toAvatarPerson } from '../domain/people';
import { usePeople } from '../model/usePeople';
import type { BudgetRow } from '../data/rows';
import type { AppDispatch } from '@/store/hooks';
import { FLAG_COLORS, colors } from './theme';
import { useFlagLabels, useFmtPrefs, useMoneyFormat, useMoneyMask } from '../model/useDisplayPrefs';

/** Surface color of the menu panes (separator ring for overlapping avatars). */
const MENU_BG = '#161a24';

/** The gear's pane set — one pane per former Settings-panel view. */
export function budgetMenuPanes(budgetId: string | null): MenuPane[] {
  return [
    { id: 'settings-root', title: 'SETTINGS', content: <SettingsRootPane /> },
    { id: 'open', title: 'OPEN BUDGET', content: <OpenBudgetPane /> },
    { id: 'budget-edit', title: 'EDIT BUDGET', content: <BudgetEditMenuPane /> },
    { id: 'new', title: 'NEW BUDGET', content: <NewBudgetPane /> },
    { id: 'people', title: 'PEOPLE', content: <PeopleRoute budgetId={budgetId} /> },
    { id: 'fresh-start', title: 'FRESH START', content: <FreshStartPane /> },
    { id: 'settings', title: 'PLAN SETTINGS', content: <PlanSettingsPane budgetId={budgetId} /> },
    {
      id: 'budget-settings',
      // Per-budget copy of Plan Settings for the EDIT BUDGET menu: same pane
      // component, but bound to the menu's target budget (not the active one).
      title: 'PLAN SETTINGS',
      content: <BudgetEditSettingsPane />,
    },
    { id: 'flags', title: 'EDIT FLAGS', content: <FlagsPane /> },
    { id: 'display', title: 'DISPLAY OPTIONS', content: <DisplayPane /> },
    { id: 'shortcuts', title: 'KEYBOARD SHORTCUTS', content: <ShortcutsPane /> },
    { id: 'account', title: 'ACCOUNT SETTINGS', content: <AccountPane /> },
  ];
}

/** Root menu — the two sections from the validated mock. */
function SettingsRootPane() {
  const nav = useMenuNav();
  const router = useRouter();
  const { openPayees, closeSidebar } = useBudgetShell();
  const [masked, setMasked] = useMoneyMask();
  const web = process.env.EXPO_OS === 'web';
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
      <MenuRow label="Make a Fresh Start" onPress={() => nav.open('fresh-start')} />
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

/**
 * Force-refetch the Budgets list and resolve the fresh rows. Same rule
 * FreshStartPane applies: switching while the invalidation refetch is still
 * in flight lets the shell's stale-list reconcile bounce the active id back
 * to data[0] — which a fresh archive just made an archived budget.
 */
async function refetchBudgets(dispatch: AppDispatch): Promise<BudgetRow[]> {
  return dispatch(
    budgetApi.endpoints.getBudgets.initiate(undefined, { forceRefetch: true }),
  ).unwrap();
}

/** Budget switcher list — every row opens the per-budget menu (EDIT BUDGET). */
function OpenBudgetPane() {
  const { formatDate } = useMoneyFormat();
  const dispatch = useAppDispatch();
  const nav = useMenuNav();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const budgets = useGetBudgetsQuery();
  const active = (budgets.data ?? []).filter((b) => !b.archived_at);
  const archived = (budgets.data ?? []).filter((b) => b.archived_at);
  return (
    <>
      {active.map((b) => (
        <MenuRow
          key={b.id}
          label={b.name}
          active={b.id === activeBudgetId}
          onPress={() => nav.openBudget(b.id)}
        />
      ))}
      {!active.length ? <Text style={s.hint}>No budgets yet.</Text> : null}
      {archived.length ? (
        <>
          <Text style={s.sectionLabel}>ARCHIVED</Text>
          {archived.map((b) => (
            <MenuRow
              key={b.id}
              label={b.archived_at ? `${b.name} · ${formatDate(b.archived_at)}` : b.name}
              onPress={() => nav.openBudget(b.id)}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

/** Per-budget menu (Open Budget rows): Open the budget, or jump to Edit. */
function BudgetEditMenuPane() {
  const dispatch = useAppDispatch();
  const nav = useMenuNav();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const budgets = useGetBudgetsQuery();
  const target = budgets.data?.find((b) => b.id === nav.editingBudgetId) ?? null;
  if (!target) return <Text style={s.hint}>Budget unavailable.</Text>;
  const open = () => {
    void dispatch(switchBudget(target.id));
    nav.close();
  };
  return (
    <>
      <Text style={s.sectionLabel}>{target.name}</Text>
      {target.id === activeBudgetId ? (
        <MenuRow label="Current Budget" active onPress={open} />
      ) : (
        <MenuRow label="Open" emphasized onPress={open} />
      )}
      <MenuRow label="Edit" onPress={() => nav.open('budget-settings')} />
    </>
  );
}

/**
 * Plan Settings for the EDIT BUDGET menu target: renders the same
 * PlanSettingsPane, but bound to the menu's budget — clicking Edit on a
 * non-active budget must configure that budget, not the active one.
 */
function BudgetEditSettingsPane() {
  const nav = useMenuNav();
  const budgets = useGetBudgetsQuery();
  const target = budgets.data?.find((b) => b.id === nav.editingBudgetId) ?? null;
  if (!target) return <Text style={s.hint}>Budget unavailable.</Text>;
  return <PlanSettingsPane budgetId={target.id} key={target.id} />;
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

/** People pane bound to the menu: "Edit profile" leaves every layer of chrome for /profile. */
function PeopleRoute({ budgetId }: { budgetId: string | null }) {
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

/** Fresh Start (AUTHORED-06) — archive the current budget, start a new one. */
function FreshStartPane() {
  const dispatch = useAppDispatch();
  const nav = useMenuNav();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const budgets = useGetBudgetsQuery();
  const [freshStart] = useFreshStartBudgetMutation();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = budgets.data?.find((b) => b.id === activeBudgetId);
  const start = () => {
    if (!activeBudgetId) return;
    setError(null);
    freshStart({ budgetId: activeBudgetId })
      .unwrap()
      .then(async ({ created }) => {
        await refetchBudgets(dispatch);
        dispatch(switchBudget(created.id));
        nav.close();
      })
      .catch((err) => setError(apiErrorMessage(err)));
  };
  return (
    <>
      <Text style={s.hint}>
        {current
          ? `Archives "${current.name}" — renamed with the archive timestamp, every row kept — and starts a new "${current.name}". Kept: accounts, linked-account balances and history through today, scheduled transactions, targets, category and payee setup. Reset: budgeted amounts, month notes, category activity. Archived budgets stay in Open Budget.`
          : 'Switch to a budget first.'}
      </Text>
      {confirm ? (
        <MenuRow label="Yes — start fresh" emphasized onPress={start} />
      ) : null}
      <MenuRow label={confirm ? 'Cancel' : 'Make a Fresh Start'} emphasized={!confirm} onPress={() => setConfirm(!confirm)} />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
    </>
  );
}

/** New Budget form (the old 'new' view) — create, switch, close. */
function NewBudgetPane() {
  const nav = useMenuNav();
  const dispatch = useAppDispatch();
  const [createBudget] = useCreateBudgetMutation();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = () => {
    const n = name.trim();
    if (!n) return;
    setError(null);
    createBudget({ name: n })
      .unwrap()
      .then((created) => dispatch(switchBudget(created.id)))
      .then(() => nav.close())
      .catch((err) => setError(apiErrorMessage(err)));
  };
  return (
    <>
      <Text style={s.hint}>Creates a fresh Budget instance with a starter group.</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Budget name"
        placeholderTextColor="#5f6878"
        onSubmitEditing={create}
        style={s.input}
        accessibilityLabel="New budget name"
        autoFocus
      />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
      <MenuRow label="Create Budget" emphasized onPress={create} />
    </>
  );
}

/** Plan Settings: name PATCH + format prefs with live preview. */
function PlanSettingsPane({ budgetId }: { budgetId: string | null }) {
  const storage = useService(Tokens.Storage);
  const dispatch = useAppDispatch();
  const budgets = useGetBudgetsQuery();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const activeBudget = budgets.data?.find((b) => b.id === budgetId);
  const [renameBudget] = useRenameBudgetMutation();
  const [planName, setPlanName] = useState(activeBudget?.name ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = budgetId === activeBudgetId;
  const fmt = useFmtPrefs();
  // Non-live targets are configured straight from their saved blob: the
  // global fmt store belongs to the ACTIVE budget and must not be touched.
  const [blobFmt, setBlobFmt] = useState<FmtPrefs>(DEFAULT_FMT_PREFS);
  useEffect(() => {
    if (live || !budgetId) return;
    let cancelled = false;
    void loadBudgetSettings(storage, budgetId).then((loaded) => {
      if (!cancelled && loaded.fmt) setBlobFmt({ ...DEFAULT_FMT_PREFS, ...loaded.fmt });
    });
    return () => {
      cancelled = true;
    };
  }, [live, budgetId, storage]);
  const currentFmt = live ? fmt : blobFmt;

  /**
   * Live target: the budgetUi slice (state/budgetSettings persists it). Other
   * budgets: only their saved blob.
   */
  const applyFmt = (patch: Partial<FmtPrefs>) => {
    if (live) {
      dispatch(setFmtPrefs(patch));
      return;
    }
    setBlobFmt((prev) => ({ ...prev, ...patch }));
    if (budgetId) void saveBudgetSettingsPatch(storage, budgetId, { fmt: patch });
  };
  const rename = () => {
    const name = planName.trim();
    if (!budgetId || !name) return;
    setError(null);
    setSaved(false);
    renameBudget({ id: budgetId, name })
      .unwrap()
      .then(() => setSaved(true))
      .catch((err) => setError(apiErrorMessage(err)));
  };

  return (
    <>
      <Text style={s.sectionLabel}>PLAN NAME</Text>
      <TextInput
        value={planName}
        onChangeText={setPlanName}
        placeholder="Budget name"
        placeholderTextColor="#5f6878"
        onSubmitEditing={rename}
        style={s.input}
        accessibilityLabel="Budget name"
      />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
      {saved ? <Text style={s.savedText}>Saved.</Text> : null}
      <MenuRow label="Rename Budget" emphasized onPress={rename} />

      <Text style={s.sectionLabel}>CURRENCY</Text>
      <Seg<FmtCurrency>
        options={[
          { value: 'BRL', label: 'R$' },
          { value: 'USD', label: 'US$' },
        ]}
        value={currentFmt.currency}
        onChange={(currency) => {
          applyFmt({ currency });
        }}
      />
      <Text style={s.sectionLabel}>SYMBOL PLACEMENT</Text>
      <Seg<FmtPlacement>
        options={[
          { value: 'before', label: 'R$ 1.314,51' },
          { value: 'after', label: '1.314,51 R$' },
          { value: 'hidden', label: '1.314,51' },
        ]}
        value={currentFmt.currencyPlacement}
        onChange={(currencyPlacement) => {
          applyFmt({ currencyPlacement });
        }}
      />
      <Text style={s.sectionLabel}>NUMBER FORMAT</Text>
      <Seg<FmtNumberLocale>
        options={[
          { value: 'pt-BR', label: '1.314,51' },
          { value: 'en-US', label: '1,314.51' },
        ]}
        value={currentFmt.numberLocale}
        onChange={(numberLocale) => {
          applyFmt({ numberLocale });
        }}
      />
      <Text style={s.sectionLabel}>DATE FORMAT</Text>
      <Seg<FmtDateFormat>
        options={[
          { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
          { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
        ]}
        value={currentFmt.dateFormat}
        onChange={(dateFormat) => {
          applyFmt({ dateFormat });
        }}
      />
      <Text style={s.preview}>
        {formatMoneyWith(currentFmt, 131451)} · {formatDateWith(currentFmt, '2026-06-30')}
      </Text>

      <Text style={s.sectionLabel}>MANAGE BUDGET</Text>
      {budgetId ? (
        <BudgetManageSection budgetId={budgetId} />
      ) : (
        <Text style={s.hint}>Switch to a budget first.</Text>
      )}
    </>
  );
}

/** Destructive half of Plan Settings — archive/unarchive + modal delete. */
function BudgetManageSection({ budgetId }: { budgetId: string }) {
  const dispatch = useAppDispatch();
  const nav = useMenuNav();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const budgets = useGetBudgetsQuery();
  const [archiveBudget] = useArchiveBudgetMutation();
  const [unarchiveBudget] = useUnarchiveBudgetMutation();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const target = budgets.data?.find((b) => b.id === budgetId) ?? null;

  if (!target) {
    return <Text style={s.hint}>Switch to a budget first.</Text>;
  }

  const archived = !!target.archived_at;
  const setArchived = (archive: boolean) => {
    setError(null);
    (archive ? archiveBudget({ id: target.id }) : unarchiveBudget({ id: target.id }))
      .unwrap()
      .then(async () => {
        await refetchBudgets(dispatch);
        // Archiving the active budget: the shell's reconcile only picks a new
        // one after the refetched list lands (it skips archived rows).
        if (archive && target.id === activeBudgetId) {
          void dispatch(clearActiveBudget());
        }
        nav.back();
      })
      .catch((err) => setError(apiErrorMessage(err)));
  };

  return (
    <>
      <Text style={s.hint}>
        {archived
          ? `"${target.name}" is archived. Unarchive to bring it back, or delete it permanently.`
          : `Archives "${target.name}" — every row is kept. Archived budgets stay in Open Budget.`}
      </Text>
      <MenuRow
        label={archived ? 'Unarchive Budget' : 'Archive Budget'}
        onPress={() => setArchived(!archived)}
      />
      <MenuRow label="Delete Budget…" chevron="✕" onPress={() => setDeleting(true)} />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
      {deleting ? <DeleteBudgetModal target={target} onClose={() => setDeleting(false)} /> : null}
    </>
  );
}

/**
 * Typed-confirmation modal for permanent budget deletion: a "Delete Budget…"
 * row opens this; the delete only fires once "delete" is typed.
 */
function DeleteBudgetModal({ target, onClose }: { target: BudgetRow; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const nav = useMenuNav();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const [deleteBudget] = useDeleteBudgetMutation();
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const armed = confirmText.trim().toLowerCase() === 'delete';
  const del = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    deleteBudget({ id: target.id })
      .unwrap()
      .then(async () => {
        if (target.id === activeBudgetId) {
          void dispatch(clearActiveBudget());
        }
        await refetchBudgets(dispatch);
        nav.back();
      })
      .catch((err) => {
        setBusy(false);
        setError(apiErrorMessage(err));
      });
  };

  return (
    <OverlaySheet visible onClose={onClose} title="Delete Permanently">
      <Text style={s.dangerNote}>
        {`Deletes "${target.name}" and every transaction, account, category and setting in it. This cannot be undone.`}
      </Text>
      <TextInput
        value={confirmText}
        onChangeText={setConfirmText}
        placeholder='Type "delete" to confirm'
        placeholderTextColor="#5f6878"
        autoCapitalize="none"
        autoCorrect={false}
        style={s.input}
        accessibilityLabel="Type delete to confirm permanent deletion"
        autoFocus
        onSubmitEditing={del}
      />
      <MenuRow label="Delete Forever" chevron="✕" onPress={del} emphasized={armed} />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
    </OverlaySheet>
  );
}

/** Edit Flags: 6 fixed colors, editable labels (YNAB parity). */
function FlagsPane() {
  const dispatch = useAppDispatch();
  const flagLabels = useFlagLabels();
  return (
    <>
      <Text style={s.hint}>{`Labels shown in the register's flag menu. Blank uses the color name.`}</Text>
      {FLAG_COLORS.map((f) => (
        <View key={f.key} style={s.flagRow}>
          <View style={[s.flagDot, { backgroundColor: f.hex }]} />
          <TextInput
            value={flagLabels[f.key]}
            onChangeText={(label) => dispatch(setFlagLabel({ color: f.key, label }))}
            placeholder={defaultFlagLabel(f.key)}
            placeholderTextColor="#5f6878"
            style={s.flagInput}
            accessibilityLabel={`${defaultFlagLabel(f.key)} flag label`}
          />
        </View>
      ))}
    </>
  );
}

/** Display Options: the RTK display toggles, persisted via the blob. */
function DisplayPane() {
  const dispatch = useAppDispatch();
  const showBars = useAppSelector((s) =>
    selectShowProgressBars(s),
  );
  const showHidden = useAppSelector((s) =>
    selectShowHiddenCategories(s),
  );
  const showClosed = useAppSelector((s) =>
    selectShowClosedAccounts(s),
  );
  return (
    <>
      <ToggleRow
        label="Progress bars"
        sub="Funding bars under plan categories"
        value={showBars}
        onChange={(v) => {
          dispatch(setShowProgressBars(v));
        }}
      />
      <ToggleRow
        label="Hidden categories"
        sub="Show hidden categories in the Plan"
        value={showHidden}
        onChange={(v) => {
          dispatch(setShowHiddenCategories(v));
        }}
      />
      <ToggleRow
        label="Closed accounts"
        sub="Show the Closed group in the account rail"
        value={showClosed}
        onChange={(v) => {
          dispatch(setShowClosedAccounts(v));
        }}
      />
    </>
  );
}

/** Keyboard Shortcuts (web only; only real shortcuts listed). */
function ShortcutsPane() {
  return (
    <>
      <ShortcutRow keys="Esc" desc="Close menus, sheets and this panel" />
      <ShortcutRow keys="Enter" desc="Commit the money field being edited" />
      <ShortcutRow keys="+ − × ÷" desc="Quick-math operators in money fields" />
    </>
  );
}

/** Account Settings: signed-in email + Back to Plan. */
function AccountPane() {
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

/** One option in a segmented-select row (Plan Settings selects). */
function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={s.seg}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          style={[s.segBtn, o.value === value && s.segBtnActive]}
          accessibilityRole="button"
          accessibilityState={{ selected: o.value === value }}
          accessibilityLabel={o.label}>
          <Text style={[s.segText, o.value === value && s.segTextActive]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A menu list row — the switcher item look (pressed + active states). */
function MenuRow({
  label,
  onPress,
  active,
  emphasized,
  chevron,
  trailing,
}: {
  label: string;
  onPress: () => void;
  /** Content between the label and the chevron (e.g. the People avatar stack). */
  trailing?: ReactNode;
  /** Current selection highlight (budget switcher). */
  active?: boolean;
  /** CTA look (Create / Rename / Back to Plan). */
  emphasized?: boolean;
  /** Right glyph override; default is the navigable chevron. */
  chevron?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        s.row,
        pressed && s.rowPressed,
        active && s.rowActive,
        emphasized && s.rowEmphasized,
      ]}>
      <Text style={[s.rowLabel, emphasized && s.rowLabelStrong, trailing ? { flex: 1 } : null]}>{label}</Text>
      {trailing}
      <Text style={s.rowChevron}>{chevron ?? '›'}</Text>
    </Pressable>
  );
}

function ToggleRow({
  label,
  sub,
  value,
  onChange,
}: {
  label: string;
  sub: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={s.rowStatic}>
      <View style={s.rowText}>
        <Text style={s.rowLabel}>{label}</Text>
        <Text style={s.rowSub}>{sub}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

function ShortcutRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <View style={s.rowStatic}>
      <Text style={s.shortcutKeys}>{keys}</Text>
      <Text style={s.rowSub}>{desc}</Text>
    </View>
  );
}

// Same palette as the switcher menu itself (shell/SettingsMenu) — the
// panes must read as part of that menu, not a different surface.
const s = StyleSheet.create({
  sectionLabel: {
    color: '#5f6878',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    marginTop: 14,
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 4, borderRadius: 8 },
  rowStatic: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    gap: 10,
  },
  rowPressed: { backgroundColor: '#232a3a' },
  rowActive: { backgroundColor: '#211d3b' },
  rowEmphasized: {
    marginTop: 8,
    backgroundColor: '#211d3b',
    borderWidth: 1,
    borderColor: '#3a3470',
  },
  dangerNote: {
    color: '#98a2b5',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { color: '#eef1f7', fontSize: 14 },
  rowLabelStrong: { color: '#eef1f7', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  rowSub: { color: '#5f6878', fontSize: 12, flexShrink: 1 },
  rowChevron: { color: '#5f6878', fontSize: 16, marginLeft: 'auto' },
  hint: { color: '#5f6878', fontSize: 12, marginTop: 10, paddingHorizontal: 4 },
  input: {
    marginTop: 8,
    backgroundColor: '#0f1219',
    borderColor: '#333c50',
    borderWidth: 1,
    borderRadius: 8,
    color: '#eef1f7',
    paddingHorizontal: 10,
    height: 36,
    fontSize: 14,
  },
  errorText: { color: colors.red, fontSize: 12, marginTop: 6 },
  savedText: { color: colors.green, fontSize: 12, marginTop: 6 },
  seg: {
    flexDirection: 'row',
    marginTop: 6,
    backgroundColor: '#0f1219',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333c50',
    overflow: 'hidden',
  },
  segBtn: { flex: 1, paddingVertical: 8, alignItems: 'center' },
  segBtnActive: { backgroundColor: '#211d3b' },
  segText: { color: '#5f6878', fontSize: 12, fontWeight: '600' },
  segTextActive: { color: '#eef1f7' },
  preview: { color: '#5f6878', fontSize: 12, marginTop: 12 },
  flagRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  flagDot: { width: 14, height: 14, borderRadius: 7 },
  flagInput: {
    flex: 1,
    backgroundColor: '#0f1219',
    borderColor: '#333c50',
    borderWidth: 1,
    borderRadius: 8,
    color: '#eef1f7',
    paddingHorizontal: 10,
    height: 34,
    fontSize: 13,
  },
  accountEmail: { color: '#eef1f7', fontSize: 14, marginTop: 4 },
  shortcutKeys: { color: '#eef1f7', fontSize: 13, fontWeight: '700', minWidth: 64 },
});
