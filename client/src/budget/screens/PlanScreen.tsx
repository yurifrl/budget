/**
 * Plan — the assign-to-categories screen (spec: budget-screens; tasks 5.x).
 *
 * SectionList of category groups → categories with ASSIGNED / ACTIVITY /
 * AVAILABLE, the Ready-to-Assign banner, filter chips, inline assigned
 * editing, funding-state pills + progress bars, the move-money flow, the
 * category inspector (panel/slide-over) and the month summary when nothing is
 * selected. All derived values come from the domain engine, every change goes
 * through `budgetApi` mutations.
 */

import { useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  View,
  type ViewInstance,
  useWindowDimensions,
  type MouseEvent,
} from 'react-native';

import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';

import {
  useAddCategoryMutation,
  useAddGroupMutation,
  useDeleteCategoryMutation,
  useDeleteGroupMutation,
  useRenameCategoryMutation,
  useRenameGroupMutation,
  useSetAssignedMutation,
  useSetCategoryPersonMutation,
  useSetGroupPersonMutation,
  useSetCategoryHiddenMutation,
  useSetMonthNoteMutation,
} from '../data/api';
import {
  assignedInFutureMonths,
  assignedInMonth,
  costToBeMe,
  groupRollup,
  neededInMonth,
  targetFundingState,
} from '../domain/engine';
import { formatMoney, formatMonth, nextMonth, prevMonth } from '../domain/format';
import {
  activityFor,
  categoriesForPerson,
  categoryOwnerId,
  distinctOwners,
  isSharedInPersonView,
  monthTotalsForPerson,
  PERSON_ALL,
  personFor,
  personLabel,
  rollupForPerson,
  SHARED_LABEL,
  sumActivityFor,
  toAvatarPerson,
  type ActivityMap,
  type Person,
  type PersonFilter,
} from '../domain/people';
import {
  EMPTY_NUMPAD_STATE,
  applyNumpadKey,
  numpadOperandText,
  type NumpadState,
} from '../domain/quickmath';
import { neededBy } from '../domain/targets';
import type { Budget, Category, CategoryGroup, Cents, MonthKey } from '../domain/types';
import {
  recordPlanEdit,
  selectActiveMonth,
  selectPlanFilter,
  selectSelectedCategoryId,
  selectShowHiddenCategories,
  selectShowProgressBars,
  selectCategory,
  setActiveMonth,
  setPlanFilter,
  toggleHiddenCategories,
  toggleProgressBars,
  type PlanFilter,
} from '../state/ui';
import {
  formatPlanEditAge,
  makeAssignEdit,
  selectPlanEdits,
  selectRecentPlanEdits,
  newPlanEdit,
} from '../state/planEdits';
import { redoPlanEdit, revertPlanEdit, undoPlanEdit } from '../state/planEditsThunks';
import { FundingBar, IndigoButton, MoneyInput, Pill } from '../ui/bits';
import { PersonFace } from '../ui/PersonFace';
import { ChevronDownIcon, PlusCircleIcon, RedoIcon, UndoIcon } from '../ui/icons';
import { colors, radius } from '../ui/theme';
import { AvatarStack } from '@/ui/avatar/AvatarStack';
import { AutoAssignPanel } from './AutoAssignPanel';
import { AssignDropdownBody } from './AssignDropdown';
import { CategoryInspector } from './CategoryInspector';
import { MobileCategoryDetail } from './MobileCategoryDetail';
import { MobileMoveMoney } from './MobileMoveMoney';
import { MobileAssignNumpad } from './MobileAssignNumpad';
import { MoveMoneyPopover, MoveMoneySheet, type MoveMoneyRequest } from './MoveMoneySheet';
import { useBudgetModel } from '../model/useBudgetModel';
import { BUNDLE_ROW_PREFIX, bundleRowKey, type DropTarget } from '../domain/bundleDrop';
import { dropIntent, planRows } from '../domain/bundles';
import { BundleRow, isBundleItem, PLAN_COLS, type BundleItem } from './BundleRow';
import { BundleNamePopover, BundleRowMenu, CategoryBundleItems, SelectionBar, useClampedMenuTop } from './BundleMenus';
import { useBundleActions } from './useBundleActions';
import { overspendHint } from '../domain/overspendHints';
import { useBudgetMonth } from '../model/useBudgetMonth';
import { usePersonFilter } from '../model/usePersonFilter';
import { categoryFigures, sumFigures, type BudgetMonth } from '../domain/zeroSum';
import { PersonFilterBar, planCaption } from './PersonFilterBar';
import { useBudgetShell } from './shell';

const FILTERS: { key: PlanFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'underfunded', label: 'Underfunded' },
  { key: 'overfunded', label: 'Overfunded' },
  { key: 'money-available', label: 'Money Available' },
  { key: 'snoozed', label: 'Snoozed' },
];

function matchesFilter(category: Category, bm: BudgetMonth, filter: PlanFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'underfunded':
      return targetFundingState(category, bm).state === 'yellow';
    case 'overfunded':
      return !!category.target && assignedInMonth(category, bm.month) > neededInMonth(category, bm.month);
    case 'money-available':
      return categoryFigures(bm, category.id).available > 0;
    case 'snoozed':
      return false;
  }
}

/** Month summary card (task 5.7) — the inspector's no-selection state. */
function MonthSummary({
  budget,
  budgetId,
  bm,
  month,
  activityMap,
  person,
  scopeLabel,
}: {
  budget: Budget;
  budgetId: string;
  /** The engine's figures for `month`. */
  bm: BudgetMonth;
  month: MonthKey;
  /** Per-person activity (null = household). */
  activityMap: ActivityMap | null;
  person: PersonFilter;
  /** "Ana’s categories" / "Shared categories"; null = Everyone. */
  scopeLabel: string | null;
}) {
  const dispatch = useAppDispatch();
  const [setMonthNote] = useSetMonthNoteMutation();
  const [note, setNote] = useState(budget.monthNotes?.[month] ?? '');
  // Assigned/Available sum the categories the Plan shows for the selection;
  // Activity is the person's (their accounts). Everyone = the household sums.
  const totals = monthTotalsForPerson(bm, budget.categories, person, activityMap);
  const activity = totals.activity;
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.summaryTitle}>{formatMonth(month)}</Text>
      {scopeLabel ? <Text style={styles.summaryScope}>{scopeLabel}</Text> : null}
      <View style={styles.summaryCard}>
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>Cost to Be Me</Text>
          <Text style={[styles.kvValue, { fontWeight: '700' }]}>{formatMoney(costToBeMe(budget, month))}</Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>Assigned</Text>
          <Text style={styles.kvValue}>{formatMoney(totals.assigned)}</Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>Activity</Text>
          <Text style={styles.kvValue}>{formatMoney(activity)}</Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>Available</Text>
          <Text style={styles.kvValue}>{formatMoney(totals.available)}</Text>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Assigned in Future Months"
        onPress={() => dispatch(setActiveMonth(nextMonth(month)))}
        style={styles.summaryCard}
      >
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>Assigned in Future Months</Text>
          <Text style={[styles.kvValue, { color: colors.indigo }]}>
            {formatMoney(assignedInFutureMonths(budget, month))}
          </Text>
        </View>
      </Pressable>
      <View style={styles.summaryCard}>
        <Text style={[styles.kvValue, { fontWeight: '700', marginBottom: 6 }]}>Month note</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          onBlur={() => {
            if (note !== (budget.monthNotes?.[month] ?? '')) {
              void setMonthNote({ budgetId, month, note });
            }
          }}
          multiline
          placeholder="Add a note for this month…"
          placeholderTextColor={colors.faint}
          style={styles.noteInput}
          accessibilityLabel="Month note"
        />
      </View>
    </ScrollView>
  );
}

export function PlanScreen() {
  const dispatch = useAppDispatch();
  const shell = useBudgetShell();
  const { budget, budgetId, isLoading, error } = useBudgetModel();
  const byPerson = usePersonFilter(budget, budgetId, { activity: true });
  const month = useAppSelector((s) => selectActiveMonth(s));
  const bm = useBudgetMonth(budget, month);
  const filter = useAppSelector((s) => selectPlanFilter(s));
  const selectedId = useAppSelector((s) => selectSelectedCategoryId(s));
  const [setAssigned] = useSetAssignedMutation();
  const [addCategory] = useAddCategoryMutation();
  const [renameCategory] = useRenameCategoryMutation();
  const [deleteCategory] = useDeleteCategoryMutation();
  const [setCategoryHidden] = useSetCategoryHiddenMutation();
  const [setCategoryPerson] = useSetCategoryPersonMutation();
  const [setGroupPerson] = useSetGroupPersonMutation();
  const [addGroup] = useAddGroupMutation();
  const [renameGroup] = useRenameGroupMutation();
  const [deleteGroup] = useDeleteGroupMutation();
  const showProgressBars = useAppSelector((s) => selectShowProgressBars(s));
  const showHiddenRow = useAppSelector((s) => selectShowHiddenCategories(s));
  const planEdits = useAppSelector((s) => selectPlanEdits(s));
  const recentMoves = useAppSelector((s) => selectRecentPlanEdits(s));
  const storage = useService(Tokens.Storage);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [moveReq, setMoveReq] = useState<MoveMoneyRequest | null>(null);
  // Phone: tapping a category row opens the full-screen YNAB-style detail page
  // instead of the inspector slide-over (selectedId stays for desktop/tablet).
  const [mobileDetailId, setMobileDetailId] = useState<string | null>(null);
  // Phone: the row-tap numpad edits this category's assigned amount live (the
  // row's ASSIGNED cell renders the engine state as a YNAB-style equation);
  // its options open move money / auto-assign / the full detail page.
  const [numpadId, setNumpadId] = useState<string | null>(null);
  const [numpadState, setNumpadState] = useState<NumpadState>(EMPTY_NUMPAD_STATE);
  // pjtv: web pills open the move/cover form in a YNAB-style popover anchored
  // under the pill (screen-root coords from anchorAt) instead of the centered
  // modal. Native keeps the sheet.
  const [pillPop, setPillPop] = useState<{ req: MoveMoneyRequest; x: number; y: number } | null>(null);
  const [autoAssignOpen, setAutoAssignOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false); // 4rr: header Assign dropdown
  const assignBtnRef = useRef<ViewInstance>(null);
  const screenRef = useRef<ViewInstance>(null);
  const [assignPos, setAssignPos] = useState<{ top: number; right: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [rename, setRename] = useState<{ id: string; kind: 'category' | 'group' } | null>(null);
  const [draftName, setDraftName] = useState('');
  const [addCatGroup, setAddCatGroup] = useState<string | null>(null);
  // xvu scope C: pill opens the add-group input inline in the toolbar (footer row kept).
  const [addingGroup, setAddingGroup] = useState<'toolbar' | 'footer' | null>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState<{ x: number; y: number } | null>(null);
  const dims = useWindowDimensions();
  // xvu scope B: pending delete of activity-bearing categories awaiting confirmation.
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[] } | null>(null);
  // xvu: initialRename opens the popover straight into its rename form
  // (right-click trigger) instead of the action list.
  const [menu, setMenu] = useState<{
    id: string;
    kind: 'category' | 'group';
    x: number;
    y: number;
    initialRename?: boolean;
  } | null>(null);
  // YNAB parity (syscd-app-42c): row multi-select, hover tracking, plan-grid drag.
  const [checkedRows, setCheckedRows] = useState<Set<string>>(new Set());
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; dy: number } | null>(null);
  const [dropAt, setDropAt] = useState<DropTarget | null>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const dropAtRef = useRef<DropTarget | null>(null);
  const rowRefs = useRef(new Map<string, ComponentRef<typeof Pressable>>());
  // pjtv: per-row AVAILABLE-pill wrapper refs — the popover anchors via
  // measureInWindow because synthetic/CDP presses report pageX≈0.
  const pillRefs = useRef(new Map<string, ComponentRef<typeof View>>());
  // qitk (T3): non-modal numpad panel — planListRef scrolls the tapped row
  // above the panel, listOffsetRef tracks the scroll offset for the delta math.
  const planListRef = useRef<SectionList<PlanItem, PlanSection> | null>(null);
  const listOffsetRef = useRef(0);
  const panelRef = useRef<ComponentRef<typeof View>>(null);
  const fixBtnRef = useRef<ComponentRef<typeof Pressable>>(null);
  const rectCache = useRef(new Map<string, { top: number; bottom: number }>());
  const [hiddenOpen, setHiddenOpen] = useState(true);
  // Bundles: expand state, drop/create/join actions, and their popovers.
  const bundleApi = useBundleActions(budget, budgetId);
  const [bundleMenu, setBundleMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [bundlePop, setBundlePop] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  /** "Add category here": the inline add row opens inside this bundle. */
  const [addCatBundle, setAddCatBundle] = useState<string | null>(null);

  // The shell slides its ＋ FAB down while the panel is open — it sits
  // exactly over the keypad's bottom-right keys otherwise. The setter is a
  // stable useState fn (the shell object itself re-memoizes), so depending on
  // it alone can't ping-pong the state.
  const reportNumpadOpen = shell.setNumpadOpen;
  useEffect(() => {
    reportNumpadOpen(numpadId !== null);
    return () => reportNumpadOpen(false);
  }, [numpadId, reportNumpadOpen]);

  // qitk (T3): on open/switch, scroll the tapped row so it sits directly
  // above the panel (8px gap). Measures row and panel in window coords and
  // scrolls by the delta — afterwards the user scrolls freely. Instant (not
  // animated) so a quick second tap re-measures a settled offset.
  useEffect(() => {
    if (!numpadId) return;
    // rAF: let the freshly mounted panel finish layout before measuring
    // (Fabric layout may not have committed when effects run).
    const raf = requestAnimationFrame(() => {
      const row = rowRefs.current.get(numpadId);
      if (!row) return;
      row.measureInWindow((_x, rowY, _w, rowH) => {
        panelRef.current?.measureInWindow((_px, panelY) => {
          if (!panelY) return; // panel not laid out yet — skip
          const delta = rowY - (panelY - NUMPAD_ALIGN_GAP - rowH);
          if (Math.abs(delta) < 1) return;
          planListRef.current
            ?.getScrollResponder()
            ?.scrollTo({ y: Math.max(0, listOffsetRef.current + delta), animated: false });
        });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [numpadId]);

  useEffect(() => {
    let alive = true;
    void storage.get<Record<string, boolean>>(COLLAPSED_KEY, {}).then((v) => {
      if (alive) setCollapsed(v ?? {});
    });
    return () => {
      alive = false;
    };
  }, [storage]);
  const hiddenCats = useMemo(() => (budget ? budget.categories.filter((c) => c.hidden) : []), [budget]);
  const hiddenTotal = useMemo(
    () => sumFigures(bm, hiddenCats.map((c) => c.id)).available,
    [hiddenCats, bm],
  );

  const sections = useMemo<PlanSection[]>(() => {
    if (!budget) return [];
    return budget.groups
      .map((g): PlanSection => {
        const cats = categoriesForPerson(
          budget.categories.filter((c) => c.groupId === g.id && !c.hidden && matchesFilter(c, bm, filter)),
          byPerson.person,
        );
        if (collapsed[g.id] && addCatGroup !== g.id)
          return { group: g, data: [] as PlanItem[], hasCats: cats.length > 0 };
        const items: PlanItem[] = [];
        for (const row of planRows(cats, budget.bundles, (c) => ({
          assigned: categoryFigures(bm, c.id).assigned,
          activity: activityFor(bm, c.id, byPerson.activity),
          available: categoryFigures(bm, c.id).available,
        }))) {
          if (row.kind === 'category') items.push(row.category);
          else {
            items.push(row);
            if (bundleApi.expanded[row.bundle.id]) items.push(...row.children);
            if (addCatGroup === g.id && addCatBundle === row.bundle.id) items.push(ADD_SENTINEL);
          }
        }
        if (addCatGroup === g.id) {
          if (!addCatBundle) items.push(ADD_SENTINEL);
          return { group: g, data: items, hasCats: true };
        }
        return { group: g, data: items, hasCats: cats.length > 0 };
      })
      // YNAB parity: an inline-added empty group stays visible on the "all"
      // filter (ready for ＋ add-category), and a collapsed group keeps its
      // header row whenever it still holds visible categories.
      .filter(
        (s) =>
          s.data.length > 0 ||
          (filter === 'all' && byPerson.person === PERSON_ALL && (s.hasCats || !collapsed[s.group.id])) ||
          // A collapsed group keeps its header while it still holds categories visible to the person.
          (byPerson.person !== PERSON_ALL && s.hasCats),
      );
  }, [budget, bm, filter, collapsed, addCatGroup, addCatBundle, byPerson.person, byPerson.activity, bundleApi.expanded]);

  // --- YNAB parity (syscd-app-42c): hooks live above the early-loading return ---
  /** Selection is per grid view — a budget or month switch starts clean. */
  useEffect(() => {
    setCheckedRows(new Set());
    setHoveredRow(null);
  }, [budgetId, month]);

  /** Drop-target row keys in display order (category ids and `bundle:<id>`). */
  const dropRowOrder = useMemo(
    () =>
      sections.flatMap((s) =>
        s.data.flatMap((row) => (typeof row === 'string' ? [] : [isBundleItem(row) ? bundleRowKey(row.bundle.id) : row.id])),
      ),
    [sections],
  );

  if (!budget || !budgetId) {
    return (
      <View style={styles.center}>
        {error ? (
          <Text style={{ color: colors.redFg, padding: 24, textAlign: 'center' }}>{error}</Text>
        ) : (
          <ActivityIndicator color={colors.indigo2} />
        )}
        {isLoading ? <Text style={{ color: colors.faint, marginTop: 10 }}>Loading budget…</Text> : null}
      </View>
    );
  }

  const commitRename = () => {
    setRename(null);
    const name = draftName.trim();
    setDraftName('');
    if (!rename || !name) return;
    if (rename.kind === 'category') void renameCategory({ budgetId, categoryId: rename.id, name });
    else void renameGroup({ budgetId, groupId: rename.id, name });
  };

  const toggleGroupCollapsed = (groupId: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      void storage.set(COLLAPSED_KEY, next);
      return next;
    });
  };

  const rta = bm.readyToAssign;
  const selected = selectedId ? budget.categories.find((c) => c.id === selectedId) : undefined;

  /** Persist one inline assigned edit and record its undo snapshot on success. */
  const recordAssigned = (categoryId: string, next: Cents) => {
    void setAssigned({ budgetId, month, categoryId, assignedCents: next })
      .unwrap()
      .then(() => {
        const draft = makeAssignEdit(budget, budgetId, month, categoryId, next);
        if (draft) dispatch(recordPlanEdit(newPlanEdit(draft)));
      })
      .catch(() => undefined);
  };

  const undoLastEdit = () => {
    setRecentOpen(null);
    void dispatch(undoPlanEdit());
  };
  const redoLastEdit = () => {
    setRecentOpen(null);
    void dispatch(redoPlanEdit());
  };

  // --- YNAB parity (syscd-app-42c): row selection, left-click menu, drag-to-move ---
  const toggleRowChecked = (id: string) => {
    setCheckedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Closes the non-modal numpad panel, discarding any pending draft. */
  const closeNumpad = () => {
    setNumpadId(null);
    setNumpadState(EMPTY_NUMPAD_STATE);
  };

  /** Left-click selects the category (inspector panel/slide-over opens);
   * phone taps open the assign numpad sheet instead. */
  const onRowPress = (c: Category, isSelected: boolean) => {
    if (suppressClickRef.current) return;
    if (shell.isPhone) {
      // qitk (T3): tapping the open row closes the panel (pending draft is
      // discarded); another row switches the editor — pristine start, and the
      // alignment effect scrolls the tapped row above the panel.
      if (c.id === numpadId) {
        closeNumpad();
      } else {
        setNumpadId(c.id);
        setNumpadState(EMPTY_NUMPAD_STATE);
      }
      return;
    }
    dispatch(selectCategory(isSelected ? null : c.id));
  };

  /** Right-click (desktop web) opens the rename popover directly — xvu steer:
   * the ONLY trigger for the Hide/Delete/Cancel/OK form. */
  const onRowContextMenu = (c: Category, e: MouseEvent) => {
    if (!shell.isDesktop) return;
    e.preventDefault();
    if (suppressClickRef.current) return;
    const px = e.nativeEvent.pageX;
    const py = e.nativeEvent.pageY;
    anchorAt(px, py, (x, y) =>
      setMenu({ id: c.id, kind: 'category', x, y, initialRename: true }));
  };

  /** Highlight text for a center drop: "Add to Medicines" / "Bundle with Doctor". */
  const dropLabel = (t: DropTarget) => {
    const bundleId = t.rowId.startsWith(BUNDLE_ROW_PREFIX)
      ? t.rowId.slice(BUNDLE_ROW_PREFIX.length)
      : budget.categories.find((c) => c.id === t.rowId)?.bundleId;
    const bundle = bundleId ? budget.bundles.find((b) => b.id === bundleId) : undefined;
    if (bundle) return `Add to ${bundle.name}`;
    return `Bundle with ${budget.categories.find((c) => c.id === t.rowId)?.name ?? ''}`;
  };

  const computeDropTarget = (y: number, dragId: string) => {
    // Over a row: top/bottom quarter reorders, the middle half bundles.
    for (const rowId of dropRowOrder) {
      if (rowId === dragId) continue;
      const rect = rectCache.current.get(rowId);
      if (rect && y >= rect.top && y <= rect.bottom) return { rowId, intent: dropIntent(y, rect) };
    }
    // Between rows / past the ends: nearest edge.
    let best: { rowId: string; intent: 'before' | 'after'; dist: number } | null = null;
    for (const rowId of dropRowOrder) {
      if (rowId === dragId) continue;
      const rect = rectCache.current.get(rowId);
      if (!rect) continue;
      const before = y < (rect.top + rect.bottom) / 2;
      const dist = Math.abs(y - (before ? rect.top : rect.bottom));
      if (!best || dist < best.dist) best = { rowId, intent: before ? 'before' : 'after', dist };
    }
    return best ? { rowId: best.rowId, intent: best.intent } : null;
  };

  /** Persist the drop (domain/bundleDrop.ts plans the moves + bundle op). */
  const commitDrag = () => {
    const st = dragRef.current;
    const target = dropAtRef.current;
    dragRef.current = null;
    dropAtRef.current = null;
    rectCache.current.clear();
    setDrag(null);
    setDropAt(null);
    if (!st || !st.active || !target || !budget) return;
    // The pointerup that ends the drag also lands as a click — swallow it.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 350);
    void bundleApi.drop(st.id, target);
  };

  /** Web pointer drag on the plan grid: grab anywhere except the checkbox. */
  const onRowPointerDown = (
    c: Category,
    e: { stopPropagation: () => void; nativeEvent: { pageX: number; pageY: number } },
  ) => {
    e.stopPropagation();
    if (process.env.EXPO_OS !== 'web' || !shell.isDesktop) return;
    dragRef.current = { id: c.id, startX: e.nativeEvent.pageX, startY: e.nativeEvent.pageY, active: false };
    dropAtRef.current = null;
    const onMove = (ev: globalThis.PointerEvent) => {
      const cur = dragRef.current;
      if (!cur || cur.id !== c.id) return;
      if (!cur.active && Math.hypot(ev.pageX - cur.startX, ev.pageY - cur.startY) > 8) {
        cur.active = true;
        setDrag({ id: c.id, dy: 0 });
        for (const rowId of dropRowOrder) {
          rowRefs.current
            .get(rowId)
            ?.measureInWindow((x, wy, w, h) => rectCache.current.set(rowId, { top: wy, bottom: wy + h }));
        }
      }
      if (!cur.active) return;
      const dy = ev.pageY - cur.startY;
      setDrag({ id: c.id, dy });
      const target = computeDropTarget(ev.pageY, c.id);
      dropAtRef.current = target;
      setDropAt(target);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      commitDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // YNAB mobile parity: ASSIGNED shows on every form factor (phone rows were
  // Available-only); ACTIVITY stays desktop/tablet where there's width.
  const showActivity = !shell.isPhone;
  // Phone has no room for a third column: with a person selected the middle
  // column becomes ACTIVITY (the only figure the person filter changes) and
  // reverts to ASSIGNED for Everyone. Row tap still opens the assign numpad.
  const phoneActivity = shell.isPhone && byPerson.person !== PERSON_ALL;

  // Menus are absolutely positioned inside this screen's root, whose offset
  // parent is the budget content shell — pageX alone mis-anchors at desktop
  // width. Convert a page point into screen-root space at press time (same
  // measureInWindow pattern as the 4rr Assign button).
  const anchorAt = (pageX: number, pageY: number, cb: (x: number, y: number) => void) => {
    screenRef.current?.measureInWindow((sx, sy) => cb(pageX - sx, pageY - sy));
  };

  return (
    <View ref={screenRef} style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
      {/* topbar: month switcher + RTA banner */}
      <View style={[styles.topbar, shell.isPhone && { flexWrap: 'wrap', justifyContent: 'center' }]}>
        <View style={styles.month}>
          <Pressable
            style={styles.navm}
            onPress={() => dispatch(setActiveMonth(prevMonth(month)))}
            accessibilityLabel="Previous month">
            <Text style={{ color: colors.muted }}>‹</Text>
          </Pressable>
          <Text style={styles.monthLabel}>{formatMonth(month)}</Text>
          <Pressable
            style={styles.navm}
            onPress={() => dispatch(setActiveMonth(nextMonth(month)))}
            accessibilityLabel="Next month">
            <Text style={{ color: colors.muted }}>›</Text>
          </Pressable>
        </View>
        <View style={[styles.rta, shell.isPhone && { flexBasis: '100%', marginLeft: 0 }]}>
          <View>
            <Text style={[styles.rtaAmount, rta < 0 && { color: colors.redFg }]}>{formatMoney(rta)}</Text>
            <Text style={styles.rtaSub}>
              Ready to Assign{byPerson.person !== PERSON_ALL ? ' · household' : ''}
            </Text>
          </View>
          <View ref={assignBtnRef}>
            <IndigoButton
              label="Assign ›"
              onPress={() => {
                assignBtnRef.current?.measureInWindow((x, y, w, h) => {
                  setAssignPos({ top: y + h + 6, right: Math.max(12, window.innerWidth - (x + w)) });
                });
                setAssignOpen(true);
              }}
            />
          </View>
        </View>
      </View>
      {/* ubgb: YNAB negative-RTA banner — red strip + Fix This opening the
          un-assign popover (web) / minimal sheet (native). */}
      {rta < 0 ? (
        <View style={styles.rtaFixBanner}>
          <Text style={styles.rtaFixText}>You&apos;ve assigned more money than you have.</Text>
          <Pressable
            ref={fixBtnRef}
            accessibilityRole="button"
            accessibilityLabel="Fix overspending"
            onPress={() =>
              // ubgb: measureInWindow anchor (event coords are unreliable for
              // synthetic/CDP presses — same rationale as the pill popovers).
              fixBtnRef.current?.measureInWindow((px, py, pw, ph) =>
                anchorAt(px + pw, py + ph + 3, (x, y) =>
                  Platform.OS === 'web'
                    ? setPillPop({ req: { from: null, to: null, unassign: true }, x, y })
                    : setMoveReq({ from: null, to: null, unassign: true }),
                ),
              )
            }>
            <Text style={styles.rtaFixAction}>Fix This</Text>
          </Pressable>
        </View>
      ) : null}
      {/* xvu scope C: YNAB-parity toolbar — left-aligned actions + right density toggles */}
      <View style={styles.toolbar}>
        <Pressable
          style={styles.toolbarAdd}
          accessibilityRole="button"
          accessibilityLabel="Add category group"
          onPress={() => setAddingGroup('toolbar')}>
          <PlusCircleIcon color="#fff" />
          <Text style={styles.toolbarAddText}>Category Group</Text>
        </Pressable>
        {addingGroup === 'toolbar' ? (
          <InlineAddRow
            placeholder="Nome do grupo"
            accessibilityLabel="New group name"
            onCommit={(name) => {
              setAddingGroup(null);
              void addGroup({ budgetId, name, sortOrder: budget.groups.length });
            }}
            onCancel={() => setAddingGroup(null)}
          />
        ) : null}
        <Pressable
          style={styles.toolbarLink}
          accessibilityLabel="Undo last plan edit"
          disabled={!planEdits.past.length}
          onPress={undoLastEdit}>
          <UndoIcon color={planEdits.past.length ? colors.indigo2 : colors.muted} />
          <Text style={[styles.toolbarLinkText, !planEdits.past.length && styles.viewsBtnDisabled]}>
            Undo
          </Text>
        </Pressable>
        <Pressable
          style={styles.toolbarLink}
          accessibilityLabel="Redo last plan edit"
          disabled={!planEdits.future.length}
          onPress={redoLastEdit}>
          <RedoIcon color={planEdits.future.length ? colors.indigo2 : colors.muted} />
          <Text style={[styles.toolbarLinkText, !planEdits.future.length && styles.viewsBtnDisabled]}>
            Redo
          </Text>
        </Pressable>
        <Pressable
          style={styles.toolbarLink}
          accessibilityLabel="Recent moves"
          onPress={(e) => {
            if (recentOpen) setRecentOpen(null);
            else {
              const px = e.nativeEvent.pageX;
              const py = e.nativeEvent.pageY;
              anchorAt(px, py, (x, y) => setRecentOpen({ x, y }));
            }
          }}>
          <Text style={styles.toolbarLinkText}>🕐 Recent Moves</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          style={styles.viewsBtn}
          accessibilityLabel="Views menu"
          onPress={() => setViewsOpen((v) => !v)}>
          <Text style={styles.viewsBtnText}>Views</Text>
          <ChevronDownIcon color={colors.text} />
        </Pressable>
      </View>

      {viewsOpen ? (
        <Pressable style={styles.menuBackdrop} onPress={() => setViewsOpen(false)}>
          <Pressable style={styles.viewsCard} onPress={() => undefined}>
            <Pressable
              style={styles.menuItem}
              accessibilityLabel="Toggle progress bars"
              onPress={() => dispatch(toggleProgressBars())}>
              <Text style={styles.menuItemText}>
                {showProgressBars ? '✓ ' : '   '}Barras de progresso
              </Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              accessibilityLabel="Toggle hidden categories row"
              onPress={() => dispatch(toggleHiddenCategories())}>
              <Text style={styles.menuItemText}>
                {showHiddenRow ? '✓ ' : '   '}Categorias ocultas
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      ) : null}

      {recentOpen ? (
        <Pressable style={styles.menuBackdrop} onPress={() => setRecentOpen(null)}>
          <Pressable
            onPress={() => undefined}
            style={[
              styles.viewsCard,
              styles.recentCard,
              { left: Math.max(12, Math.min(recentOpen.x, dims.width - 330)), top: recentOpen.y + 6 },
            ]}>
            <Text style={styles.menuTitle}>RECENT MOVES</Text>
            {recentMoves.length === 0 ? (
              <Text style={[styles.menuItemText, styles.recentAge]}>No moves yet</Text>
            ) : (
              recentMoves.map((e) => (
                <Pressable
                  key={e.id}
                  style={styles.menuItem}
                  accessibilityLabel={`Revert ${e.label}`}
                  onPress={() => void dispatch(revertPlanEdit(e.id))}>
                  <View style={styles.recentRow}>
                    <Text style={styles.menuItemText} numberOfLines={1}>
                      {e.label}
                      {e.month !== month ? ` · ${formatMonth(e.month)}` : ''}
                    </Text>
                    <Text style={styles.recentAge}>{formatPlanEditAge(e.at)}</Text>
                  </View>
                </Pressable>
              ))
            )}
          </Pressable>
        </Pressable>
      ) : null}

      {/* filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={{ gap: 8 }}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            onPress={() => dispatch(setPlanFilter(f.key))}
            style={[styles.chip, filter === f.key && styles.chipActive]}>
            <Text style={[styles.chipText, filter === f.key && { color: '#fff' }]}>{f.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <PersonFilterBar byPerson={byPerson} budgetId={budgetId} caption={planCaption(byPerson)} showOwnsNoneHint />

      <View style={{ flex: 1, flexDirection: 'row' }}>
        <View style={{ flex: 1 }}>
          {checkedRows.size >= 2 ? (
            <SelectionBar
              count={checkedRows.size}
              onClear={() => setCheckedRows(new Set())}
              onBundle={(px, py) => anchorAt(px, py, (x, y) => setBundlePop({ x, y, ids: [...checkedRows] }))}
            />
          ) : null}
          {/* table header */}
          <View style={styles.thead}>
            <Text style={[styles.theadText, { flex: 1 }]}>CATEGORY</Text>
            <Text style={[styles.theadText, styles.colNum, shell.isPhone && styles.colNumPhone]}>{phoneActivity ? 'ACTIVITY' : 'ASSIGNED'}</Text>
            {showActivity ? <Text style={[styles.theadText, styles.colNum]}>ACTIVITY</Text> : null}
            <Text style={[styles.theadText, styles.colAvail, shell.isPhone && styles.colAvailPhone]}>AVAILABLE</Text>
          </View>
          <SectionList
            sections={sections}
            keyExtractor={(c) => (typeof c === 'string' ? c : isBundleItem(c) ? bundleRowKey(c.bundle.id) : c.id)}
            stickySectionHeadersEnabled={false}
            ref={planListRef}
            scrollEventThrottle={16}
            onScroll={(e) => {
              listOffsetRef.current = e.nativeEvent.contentOffset.y;
            }}
            ListFooterComponent={() => (
              <View>
                {showHiddenRow && hiddenCats.length > 0 ? (
                  <View>
                    <Pressable
                      style={styles.groupRow}
                      onPress={() => setHiddenOpen((o) => !o)}
                      accessibilityLabel="Hidden categories">
                      <Text style={styles.groupName}>
                        {hiddenOpen ? '⌄' : '▸'} Categorias ocultas ({hiddenCats.length})
                      </Text>
                      <View style={{ flexDirection: 'row' }}>
                        <Text style={[styles.groupTotal, styles.colAvail]}>{formatMoney(hiddenTotal)}</Text>
                      </View>
                    </Pressable>
                    {hiddenOpen
                      ? hiddenCats.map((c) => (
                          <View
                            key={c.id}
                            style={[styles.trow, { flexDirection: 'row', alignItems: 'center' }]}>
                            <Text style={[styles.catName, { flex: 1 }]} numberOfLines={1}>
                              {c.name}
                            </Text>
                            <Text style={[styles.numText, styles.colAvail]}>
                              {formatMoney(categoryFigures(bm, c.id).available)}
                            </Text>
                            <Pressable
                              style={styles.rowMenuBtn}
                              accessibilityLabel={`Restore ${c.name}`}
                              onPress={() =>
                                void setCategoryHidden({ budgetId, categoryId: c.id, hidden: false })
                              }>
                              <Text style={styles.rowMenuText}>Restaurar</Text>
                            </Pressable>
                          </View>
                        ))
                      : null}
                  </View>
                ) : null}
                {addingGroup === 'footer' ? (
                  <InlineAddRow
                    placeholder="Nome do grupo"
                    accessibilityLabel="New group name"
                    onCommit={(name) => {
                      setAddingGroup(null);
                      void addGroup({ budgetId, name, sortOrder: budget.groups.length });
                    }}
                    onCancel={() => setAddingGroup(null)}
                  />
                ) : (
                  <Pressable
                    style={styles.addRow}
                    onPress={() => setAddingGroup('footer')}
                    accessibilityLabel="Add category group">
                    <Text style={styles.addRowText}>＋ Adicionar grupo de categorias</Text>
                  </Pressable>
                )}
              </View>
            )}
            renderSectionHeader={({ section }) => {
              const groupCats = budget.categories.filter((c) => c.groupId === section.group.id);
              const roll =
                byPerson.person === PERSON_ALL
                  ? groupRollup(budget, bm, section.group.id)
                  : rollupForPerson(bm, groupCats, byPerson.person, null);
              const groupOwners = distinctOwners(categoriesForPerson(groupCats.filter((c) => !c.hidden), byPerson.person))
                .map((id) => personFor(byPerson.people, id))
                .filter((p): p is Person => p !== null);
              const isCollapsed = !!collapsed[section.group.id];
              return (
                <View style={styles.groupRow}>
                  {rename?.kind === 'group' && rename.id === section.group.id ? (
                    <TextInput
                      value={draftName}
                      onChangeText={setDraftName}
                      onSubmitEditing={commitRename}
                      onBlur={commitRename}
                      autoFocus
                      style={styles.renameInput}
                      accessibilityLabel="Rename group"
                    />
                  ) : (
                    <Pressable
                      style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
                      onPress={() => toggleGroupCollapsed(section.group.id)}
                      accessibilityLabel={`Toggle ${section.group.name} group`}>
                      <Text style={styles.groupName}>
                        {isCollapsed ? '▸' : '⌄'} {section.group.name}
                      </Text>
                      {groupOwners.length > 0 ? (
                        <View
                          style={{ marginLeft: 8 }}
                          accessible
                          accessibilityLabel={`Categories of ${groupOwners.map(personLabel).join(', ')}`}>
                          <AvatarStack people={groupOwners.map(toAvatarPerson)} max={3} size={16} ring={colors.bg} />
                        </View>
                      ) : null}
                    </Pressable>
                  )}
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Pressable
                      style={styles.rowMenuBtn}
                      accessibilityLabel={`Add category to ${section.group.name}`}
                      onPress={() => setAddCatGroup(section.group.id)}>
                      <Text style={styles.rowMenuText}>＋</Text>
                    </Pressable>
                    <Pressable
                      style={styles.rowMenuBtn}
                      accessibilityLabel={`${section.group.name} group options`}
                      onPress={(e) => {
                        const px = e.nativeEvent.pageX;
                        const py = e.nativeEvent.pageY;
                        anchorAt(px, py, (x, y) =>
                          setMenu({ id: section.group.id, kind: 'group', x, y }));
                      }}>
                      <Text style={styles.rowMenuText}>⋯</Text>
                    </Pressable>
                    <Text style={[styles.groupTotal, styles.colNum, shell.isPhone && styles.colNumPhone]}>{formatMoney(
                      phoneActivity
                        ? sumActivityFor(
                            bm,
                            budget.categories.filter((cat) => cat.groupId === section.group.id),
                            byPerson.activity,
                          )
                        : roll.assigned,
                    )}</Text>
                    <Text style={[styles.groupTotal, styles.colAvail, shell.isPhone && styles.colAvailPhone]}>{formatMoney(roll.available)}</Text>
                  </View>
                </View>
              );
            }}
            renderItem={({ item: c, section }) => {
              if (typeof c === 'string') {
                const groupId = section.group.id;
                return (
                  <InlineAddRow
                    placeholder="Nome da categoria"
                    accessibilityLabel="New category name"
                    onCommit={(name) => {
                      const intoBundle = addCatBundle;
                      setAddCatGroup(null);
                      setAddCatBundle(null);
                      void addCategory({
                        budgetId,
                        groupId,
                        name,
                        sortOrder: budget.categories.filter((x) => x.groupId === groupId).length,
                      })
                        .unwrap()
                        .then((made) => {
                          if (intoBundle) void bundleApi.join([made.id], intoBundle, [{ id: made.id, groupId }]);
                        })
                        .catch(() => undefined);
                    }}
                    onCancel={() => {
                      setAddCatGroup(null);
                      setAddCatBundle(null);
                    }}
                  />
                );
              }
              if (isBundleItem(c)) {
                const key = bundleRowKey(c.bundle.id);
                const hover = drag && dropAt?.rowId === key ? dropAt.intent : null;
                return (
                  <BundleRow
                    item={c}
                    expanded={!!bundleApi.expanded[c.bundle.id]}
                    onToggle={() => bundleApi.toggle(c.bundle.id)}
                    onMenu={(px, py) => anchorAt(px, py, (x, y) => setBundleMenu({ id: c.bundle.id, x, y }))}
                    renaming={bundleApi.renamingId === c.bundle.id}
                    onRename={(name) => bundleApi.rename(c.bundle.id, name)}
                    onRenameDone={() => bundleApi.setRenamingId(null)}
                    dropLabel={hover === 'bundle' ? dropLabel(dropAt!) : null}
                    dropLine={hover === 'before' ? 'top' : hover === 'after' ? 'bottom' : null}
                    isPhone={shell.isPhone}
                    showActivity={showActivity}
                    showAssignedAsActivity={phoneActivity}
                    rowRef={(el) => {
                      if (el) rowRefs.current.set(key, el);
                      else rowRefs.current.delete(key);
                    }}
                  />
                );
              }
              const target = c.target ?? null;
              const funding = targetFundingState(c, bm);
              const { available, assigned } = categoryFigures(bm, c.id);
              const hint = overspendHint(bm, c.id);
              const isSelected = selectedId === c.id;
              const fraction =
                funding.neededThisMonth > 0
                  ? funding.fundedSoFar / funding.neededThisMonth
                  : available > 0
                    ? 1
                    : 0;
              const owner = personFor(byPerson.people, categoryOwnerId(c));
              const isChecked = checkedRows.has(c.id);
              const isDragging = drag?.id === c.id;
              return (
                <Pressable
                  ref={(el) => {
                    if (el) rowRefs.current.set(c.id, el);
                    else rowRefs.current.delete(c.id);
                  }}
                  onPointerDown={(e) => onRowPointerDown(c, e)}
                  onContextMenu={(e) => onRowContextMenu(c, e)}
                  onLongPress={
                    shell.isDesktop
                      ? undefined
                      : (e) => {
                          const px = e.nativeEvent.pageX;
                          const py = e.nativeEvent.pageY;
                          anchorAt(px, py, (x, y) =>
                            setMenu({ id: c.id, kind: 'category', x, y }));
                        }
                  }
                  onPress={() => onRowPress(c, isSelected)}
                  disabled={isDragging}
                  onHoverIn={shell.isDesktop ? () => setHoveredRow(c.id) : undefined}
                  onHoverOut={shell.isDesktop ? () => setHoveredRow((h) => (h === c.id ? null : h)) : undefined}
                  style={[
                    styles.trow,
                    isSelected && styles.trowSelected,
                    isChecked && styles.trowChecked,
                    isDragging && styles.trowDragging,
                    c.bundleId && budget.bundles.some((b) => b.id === c.bundleId) && styles.trowChild,
                    drag && dropAt?.rowId === c.id && dropAt.intent === 'bundle' && styles.trowBundleTarget,
                    isDragging && drag ? { transform: [{ translateY: drag.dy }] } : null,
                  ]}>
                  {isChecked ? <View style={styles.selBar} /> : null}
                  {drag && dropAt?.rowId === c.id && dropAt.intent !== 'bundle' ? (
                    <View style={[styles.dropLine, dropAt.intent === 'before' ? styles.dropTop : styles.dropBottom]} />
                  ) : null}
                  {isDragging && dropAt?.intent === 'bundle' ? (
                    <View style={styles.bundleDropChip} pointerEvents="none">
                      <Text style={styles.bundleDropChipText}>{dropLabel(dropAt)}</Text>
                    </View>
                  ) : null}
                  <View style={styles.trowInner}>
                    <Pressable
                      style={styles.checkCell}
                      onPointerDown={(e) => e.stopPropagation()}
                      onPress={(e) => {
                        e.stopPropagation();
                        toggleRowChecked(c.id);
                      }}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isChecked }}
                      accessibilityLabel={`Select ${c.name}`}>
                      <View
                        style={[
                          styles.checkbox,
                          isChecked && styles.checkboxOn,
                          shell.isDesktop && !isChecked && hoveredRow !== c.id && styles.checkboxHidden,
                        ]}>
                        {isChecked ? <Text style={styles.checkMark}>✓</Text> : null}
                      </View>
                    </Pressable>
                    {rename?.kind === 'category' && rename.id === c.id ? (
                      <TextInput
                        value={draftName}
                        onChangeText={setDraftName}
                        onSubmitEditing={commitRename}
                        onBlur={commitRename}
                        autoFocus
                        style={styles.renameInput}
                        accessibilityLabel="Rename category"
                      />
                    ) : (
                      <View style={{ flex: 1 }} pointerEvents="none">
                        {/* xvu steer: left-click anywhere on the row (name included)
                            selects it and opens the inspector — the rename popover is
                            right-click only. */}
                        <View style={styles.catNameRow}>
                          <Text
                            style={[styles.catName, isSharedInPersonView(c, byPerson.person) && styles.catNameShared]}
                            numberOfLines={1}>
                            {c.name}
                          </Text>
                          {owner ? (
                            <View accessible accessibilityLabel={`Category of ${personLabel(owner)}`}>
                              <PersonFace person={owner} size={16} />
                            </View>
                          ) : null}
                        </View>
                        {hint ? (
                          <Text
                            style={[styles.catHint, { color: colors.yellowPillFg }]}
                            numberOfLines={1}
                            accessibilityLabel={hint.detail}>
                            {hint.label}
                          </Text>
                        ) : null}
                      </View>
                    )}
                    {phoneActivity ? (
                      <View style={styles.colNumPhone}>
                        <Text style={[styles.numText, styles.numTextPhone, { color: colors.muted }]} numberOfLines={1}>
                          {formatMoney(activityFor(bm, c.id, byPerson.activity))}
                        </Text>
                      </View>
                    ) : shell.isPhone ? (
                      <View style={styles.colNumPhone}>
                        {numpadId === c.id ? (
                          numpadState.op !== '=' ? (
                            // Stacked equation: old number on top, the pending
                            // '+operand' under (YNAB parity), caret trailing.
                            <>
                              <Text
                                style={[styles.numText, styles.numTextPhone, styles.numpadEditLine]}
                                numberOfLines={1}>
                                {formatMoney(numpadState.base ?? assigned)}
                              </Text>
                              <Text
                                style={[styles.numText, styles.numTextPhone, styles.numpadEditLine]}
                                numberOfLines={1}>
                                {numpadState.op +
                                  (numpadState.operand ? ` ${numpadOperandText(numpadState.operand)}` : '')}
                                |
                              </Text>
                            </>
                          ) : (
                            // Single line under '=': the typed operand, or the
                            // (possibly just-resolved) base, caret trailing.
                            <Text
                              style={[styles.numText, styles.numTextPhone, styles.numpadEditLine]}
                              numberOfLines={1}>
                              {(numpadState.operand
                                ? numpadOperandText(numpadState.operand)
                                : formatMoney(numpadState.base ?? assigned)) + '|'}
                            </Text>
                          )
                        ) : (
                          <Text style={[styles.numText, styles.numTextPhone]} numberOfLines={1}>
                            {formatMoney(assigned)}
                          </Text>
                        )}
                      </View>
                    ) : (
                      <Pressable
                        style={styles.colNum}
                        onPress={() => setEditingId(c.id)}
                        accessibilityLabel={`Edit assigned for ${c.name}`}>
                        {editingId === c.id ? (
                          <MoneyInput
                            cents={assigned}
                            autoFocus
                            quickMath
                            onEscape={() => setEditingId(null)}
                            onCommit={(next) => {
                              setEditingId(null);
                              if (next !== assigned) recordAssigned(c.id, next);
                            }}
                          />
                        ) : (
                          <Text style={styles.numText} numberOfLines={1}>
                            {formatMoney(assigned)}
                          </Text>
                        )}
                      </Pressable>
                    )}
                    {showActivity ? (
                      <Text style={[styles.numText, styles.colNum, { color: colors.muted }]}>
                        {formatMoney(activityFor(bm, c.id, byPerson.activity))}
                      </Text>
                    ) : null}
                    <View
                      style={[styles.colAvail, shell.isPhone && styles.colAvailPhone]}
                      ref={(el) => {
                        if (el) pillRefs.current.set(c.id, el);
                        else pillRefs.current.delete(c.id);
                      }}>
                      <Pill
                        state={funding.state}
                        cents={available}
                        small={shell.isPhone}
                        progress={
                          target != null
                            ? neededBy(target, month) > 0
                              ? Math.min(1, Math.max(0, assigned / neededBy(target, month)))
                              : null
                            : fraction
                        }
                        // Phone (xvu steer): the whole line opens the assign
                        // numpad — no pill press; move money stays reachable
                        // via the numpad/detail. Desktop/web keep the pill.
                        onPress={shell.isPhone ? undefined : () =>
                          // YNAB pill behavior (syscd-app-6jns): overspent →
                          // "Cover overspending from"; otherwise "Move".
                          // pjtv: web anchors the form under the pill via
                          // measureInWindow (synthetic/CDP presses report
                          // pageX≈0 — event coords unreliable); native keeps
                          // the centered sheet.
                          pillRefs.current.get(c.id)?.measureInWindow((px, py, pw, ph) =>
                            anchorAt(px + pw, py + ph + 3, (x, y) =>
                              available < 0
                                ? Platform.OS === 'web'
                                  ? setPillPop({ req: { from: null, to: c.id, pickFrom: true }, x, y })
                                  : setMoveReq({ from: null, to: c.id, pickFrom: true })
                                : Platform.OS === 'web'
                                  ? setPillPop({ req: { from: c.id }, x, y })
                                  : setMoveReq({ from: c.id }),
                            ),
                          )
                        }
                      />
                    </View>
                  </View>
                  {showProgressBars ? <FundingBar state={funding.state} fraction={fraction} /> : null}
                </Pressable>
              );
            }}
          />
        </View>

        {/* inspector: fixed panel on desktop, slide-over otherwise */}
        {shell.isDesktop && !selected ? (
          <View style={styles.summaryPanel}>
            <MonthSummary
              key={month}
              budget={budget}
              budgetId={budgetId}
              bm={bm}
              month={month}
              activityMap={byPerson.activity}
              person={byPerson.person}
              scopeLabel={byPerson.scopeLabel}
            />
          </View>
        ) : null}
        {selected ? (
          <CategoryInspector
            budget={budget}
            budgetId={budgetId}
            month={month}
            category={selected}
            overlay={!shell.isDesktop}
            onClose={() => dispatch(selectCategory(null))}
            activityMap={byPerson.activity}
            personName={byPerson.label}
            onMoveMoney={(req) => setMoveReq(req)}
            onAutoAssign={() => setAutoAssignOpen(true)}
          />
        ) : null}
      </View>

      {/* 4rr: header Assign dropdown (portal-less, backdrop + measured anchor) */}
      {assignOpen && assignPos ? (
        <Pressable style={styles.menuBackdrop} onPress={() => setAssignOpen(false)}>
          <Pressable
            style={[styles.assignCard, { top: assignPos.top, right: assignPos.right }]}
            onPress={() => undefined}>
            <AssignDropdownBody
              budget={budget}
              budgetId={budgetId}
              month={month}
              rtaCents={rta}
              onDone={() => setAssignOpen(false)}
            />
          </Pressable>
        </Pressable>
      ) : null}
      {autoAssignOpen ? (
        <AutoAssignPanel
          visible
          onClose={() => setAutoAssignOpen(false)}
          budget={budget}
          budgetId={budgetId}
          month={month}
          rtaCents={rta}
        />
      ) : null}
      {/* pjtv: YNAB-anchored move/cover popover under the pressed pill (web). */}
      {pillPop ? (
        <Pressable style={styles.menuBackdrop} onPress={() => setPillPop(null)}>
          <Pressable
            style={[
              styles.pillPopCard,
              {
                left: Math.max(12, Math.min(pillPop.x - 24, dims.width - 312)),
                // YNAB flips the popover above the pill when it won't fit
                // below; ~320px of card keeps it inside the viewport either way.
                top: Math.min(pillPop.y + 14, Math.max(12, dims.height - 330)),
              },
            ]}
            onPress={() => undefined}>
            <MoveMoneyPopover
              budget={budget}
              budgetId={budgetId}
              month={month}
              request={pillPop.req}
              onClose={() => setPillPop(null)}
            />
          </Pressable>
        </Pressable>
      ) : null}
      {moveReq ? (
        shell.isPhone ? (
          <MobileMoveMoney
            visible
            onClose={() => setMoveReq(null)}
            budget={budget}
            budgetId={budgetId}
            month={month}
            request={moveReq}
          />
        ) : (
          <MoveMoneySheet
            visible
            onClose={() => setMoveReq(null)}
            budget={budget}
            budgetId={budgetId}
            month={month}
            request={moveReq}
          />
        )
      ) : null}
      {mobileDetailId && budget && budget.categories.some((c) => c.id === mobileDetailId) ? (
        <MobileCategoryDetail
          visible
          budget={budget}
          budgetId={budgetId}
          month={month}
          category={budget.categories.find((c) => c.id === mobileDetailId)!}
          activityMap={byPerson.activity}
          personName={byPerson.label}
          onClose={() => setMobileDetailId(null)}
          onMoveMoney={(req) => {
            setMobileDetailId(null);
            setMoveReq(req);
          }}
        />
      ) : null}
      {numpadId && budget && budget.categories.some((c) => c.id === numpadId) ? (
        <MobileAssignNumpad
          key={numpadId}
          onClose={closeNumpad}
          budget={budget}
          budgetId={budgetId}
          month={month}
          category={budget.categories.find((c) => c.id === numpadId)!}
          state={numpadState}
          onKey={(key) => setNumpadState((prev) => applyNumpadKey(prev, key))}
          onMoveMoney={() => {
            closeNumpad();
            setMoveReq({ from: numpadId });
          }}
          onMoreDetails={() => {
            closeNumpad();
            setMobileDetailId(numpadId);
          }}
          recordAssigned={recordAssigned}
          panelRef={panelRef}
        />
      ) : null}
      {confirmDelete ? (
        <Pressable style={styles.menuBackdrop} onPress={() => setConfirmDelete(null)}>
          <Pressable style={[styles.rowMenuCard, { top: 44, right: 16 }]} onPress={() => undefined}>
            <Text style={styles.menuItemText}>
              Esta categoria tem atividade neste mês. Excluir? As transações manterão o histórico.
            </Text>
            <View style={styles.sheetRow}>
              <Pressable
                style={styles.menuItem}
                accessibilityLabel="Confirm delete"
                onPress={() => {
                  const ids = confirmDelete.ids;
                  setConfirmDelete(null);
                  for (const cid of ids) void deleteCategory({ budgetId, categoryId: cid });
                  if (ids.length > 1) setCheckedRows(new Set());
                }}>
                <Text style={styles.menuItemTextDanger}>Excluir</Text>
              </Pressable>
              <Pressable
                style={styles.menuItem}
                accessibilityLabel="Cancel delete"
                onPress={() => setConfirmDelete(null)}>
                <Text style={styles.menuItemText}>Cancelar</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      ) : null}
      {bundleMenu && budget.bundles.some((b) => b.id === bundleMenu.id) ? (
        <BundleRowMenu
          bundle={budget.bundles.find((b) => b.id === bundleMenu.id)!}
          x={bundleMenu.x}
          y={bundleMenu.y}
          onClose={() => setBundleMenu(null)}
          onRename={() => {
            bundleApi.setRenamingId(bundleMenu.id);
            setBundleMenu(null);
          }}
          onAddCategory={() => {
            const b = budget.bundles.find((x) => x.id === bundleMenu.id)!;
            setBundleMenu(null);
            bundleApi.setOpen(b.id, true);
            setCollapsed((prev) => ({ ...prev, [b.groupId]: false }));
            setAddCatBundle(b.id);
            setAddCatGroup(b.groupId);
          }}
          onUngroup={() => {
            bundleApi.ungroup(bundleMenu.id);
            setBundleMenu(null);
          }}
        />
      ) : null}
      {bundlePop ? (
        <BundleNamePopover
          x={bundlePop.x}
          y={bundlePop.y}
          ids={bundlePop.ids}
          categories={budget.categories}
          onClose={() => setBundlePop(null)}
          onSubmit={(ids, name) => {
            setBundlePop(null);
            setCheckedRows(new Set());
            bundleApi.createFrom(ids, name);
          }}
        />
      ) : null}
      {menu ? (
        <RowMenu
          key={menu.id}
          menu={menu}
          desktop={shell.isDesktop}
          batch={menu.kind === 'category' && checkedRows.size > 1 && checkedRows.has(menu.id)}
          initialRename={menu.initialRename === true}
          bundleItems={
            menu.kind === 'category'
              ? (() => {
                  const cat = budget.categories.find((c) => c.id === menu.id);
                  if (!cat) return null;
                  const ids = checkedRows.size > 1 && checkedRows.has(cat.id) ? [...checkedRows] : [cat.id];
                  return (
                    <CategoryBundleItems
                      bundlesInGroup={budget.bundles.filter((b) => b.groupId === cat.groupId)}
                      currentBundleId={cat.bundleId}
                      onJoin={(bundleId) => {
                        setMenu(null);
                        void bundleApi.join(ids, bundleId);
                      }}
                      onNew={() => {
                        setMenu(null);
                        setBundlePop({ x: menu.x, y: menu.y, ids });
                      }}
                      onLeave={() => {
                        setMenu(null);
                        bundleApi.leave(ids);
                      }}
                    />
                  );
                })()
              : null
          }
          people={byPerson.people}
          currentOwnerId={
            menu.kind === 'category' ? categoryOwnerId(budget.categories.find((c) => c.id === menu.id) ?? {}) : undefined
          }
          onAssign={(userId) => {
            const { id, kind } = menu;
            setMenu(null);
            if (kind === 'group') {
              void setGroupPerson({ budgetId, groupId: id, userId });
              return;
            }
            const ids = checkedRows.size > 1 && checkedRows.has(id) ? [...checkedRows] : [id];
            for (const cid of ids) void setCategoryPerson({ budgetId, categoryId: cid, userId });
          }}
          name={(() => {
            if (menu.kind === 'group') return budget.groups.find((g) => g.id === menu.id)?.name ?? '';
            return budget.categories.find((c) => c.id === menu.id)?.name ?? '';
          })()}
          onClose={() => setMenu(null)}
          onRename={
            menu.kind === 'category' && checkedRows.size > 1 && checkedRows.has(menu.id)
              ? null
              : () => {
                  const { id, kind } = menu;
                  setMenu(null);
                  setRename({ id, kind });
                  setDraftName(kind === 'group' ? (budget.groups.find((g) => g.id === id)?.name ?? '') : (budget.categories.find((c) => c.id === id)?.name ?? ''));
                }
          }
          onHide={
            menu.kind === 'category'
              ? () => {
                  setMenu(null);
                  const ids = checkedRows.size > 1 && checkedRows.has(menu.id) ? [...checkedRows] : [menu.id];
                  for (const cid of ids) void setCategoryHidden({ budgetId, categoryId: cid, hidden: true });
                  if (ids.length > 1) setCheckedRows(new Set());
                }
              : null
          }
          onDelete={() => {
            const { id, kind } = menu;
            const ids =
              kind === 'category' && checkedRows.size > 1 && checkedRows.has(id)
                ? [...checkedRows]
                : [id];
            // xvu scope B: activity-bearing categories ask confirmation (YNAB parity).
            const hasActivity =
              kind === 'category' &&
              ids.some((cid) => {
                const c = budget.categories.find((x) => x.id === cid);
                return c ? categoryFigures(bm, c.id).activity !== 0 : false;
              });
            setMenu(null);
            if (kind === 'category') {
              if (hasActivity) {
                setConfirmDelete({ ids });
                return;
              }
              for (const cid of ids) void deleteCategory({ budgetId, categoryId: cid });
              if (ids.length > 1) setCheckedRows(new Set());
            } else {
              void deleteGroup({ budgetId, groupId: id });
            }
          }}
          onCommitRename={(name) => {
            if (menu.kind === 'category') void renameCategory({ budgetId, categoryId: menu.id, name });
            else void renameGroup({ budgetId, groupId: menu.id, name });
          }}
        />
      ) : null}
    </View>
  );
}

/** SectionList sentinel row for the inline "add category" input. */
const ADD_SENTINEL = '__add_category__';

/** One plan SectionList section: a group and its visible rows (string = ADD_SENTINEL). */
type PlanItem = Category | BundleItem | typeof ADD_SENTINEL;
type PlanSection = {
  group: CategoryGroup;
  data: readonly PlanItem[];
  hasCats: boolean;
};

/** KVStore key persisting the per-group collapsed map across reloads. */
const COLLAPSED_KEY = 'budget.plan.collapsedGroups';

/** Gap between the tapped row's bottom edge and the numpad panel's top edge. */
const NUMPAD_ALIGN_GAP = 8;

/** Inline "＋ nome…" row: commits on Enter/blur, cancels on empty blur. */
function InlineAddRow({
  placeholder,
  accessibilityLabel,
  onCommit,
  onCancel,
}: {
  placeholder: string;
  accessibilityLabel: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  return (
    <View style={styles.addRow}>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        autoFocus
        onSubmitEditing={() => {
          const name = value.trim();
          if (name) onCommit(name);
        }}
        onBlur={() => {
          const name = value.trim();
          if (name) onCommit(name);
          else onCancel();
        }}
        style={styles.addRowInput}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

/**
 * Absolutely-positioned context menu for a grid row (YNAB parity, syscd-app-42c):
 * desktop gets the two-stage popover — item list, then an inline rename form
 * (name input + Hide / Delete / Cancel / OK). `batch` marks a multi-row
 * selection: Hide/Delete act on the whole selection, rename is disabled.
 */
function RowMenu({
  menu,
  name,
  desktop,
  batch,
  initialRename = false,
  bundleItems = null,
  people,
  currentOwnerId,
  onAssign,
  onClose,
  onRename,
  onHide,
  onDelete,
  onCommitRename,
}: {
  menu: { id: string; kind: 'category' | 'group'; x: number; y: number };
  name: string;
  desktop: boolean;
  batch: boolean;
  /** xvu: right-click opens the popover straight into the rename form. */
  initialRename?: boolean;
  /** Bundle entries (Add to bundle ▸ / New bundle… / Remove from bundle) for category menus. */
  bundleItems?: ReactNode;
  /** Budget members; the "Assign to" list shows when there is at least one person (the viewer counts). */
  people: readonly Person[];
  /** The category's current owner (undefined for a group, null = Shared). */
  currentOwnerId?: string | null;
  onAssign: (userId: string | null) => void;
  onClose: () => void;
  onRename: (() => void) | null;
  onHide: (() => void) | null;
  onDelete: () => void;
  onCommitRename?: (name: string) => void;
}) {
  const [renaming, setRenaming] = useState(initialRename);
  const pos = useClampedMenuTop(menu.y);
  const [draft, setDraft] = useState(name);
  const renameRef = useRef<TextInputInstance>(null);

  // Escape (and Enter-to-commit) close the menu — web only, capture so the
  // grid's own shortcuts don't eat it first.
  useEffect(() => {
    if (process.env.EXPO_OS !== 'web') return undefined;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (desktop && renaming) {
      const t = window.setTimeout(() => renameRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [desktop, renaming]);

  const startRename = () => {
    if (desktop && !batch) setRenaming(true);
    else onRename?.();
  };

  const commitRename = () => {
    const next = draft.trim();
    if (next && onCommitRename) {
      onCommitRename(next);
      onClose();
    } else if (!next) {
      setRenaming(false);
    }
  };

  const isGroup = menu.kind === 'group';
  const assignBlock =
    people.length > 0 ? (
        <View accessibilityRole="menu" accessibilityLabel="Assign to">
          <Text style={styles.menuSubhead}>{isGroup ? 'Assign group to…' : 'Assign to…'}</Text>
          {[null, ...people].map((p) => {
            const label = p ? personLabel(p) : SHARED_LABEL;
            const on = currentOwnerId !== undefined && (p?.user_id ?? null) === currentOwnerId;
            return (
              <Pressable
                key={p?.user_id ?? 'shared'}
                style={[styles.menuItem, styles.menuPersonRow]}
                accessibilityRole="menuitem"
                accessibilityLabel={`Assign to ${label}`}
                onPress={() => onAssign(p?.user_id ?? null)}>
                <PersonFace person={p} size={18} />
                <Text style={[styles.menuItemText, { flex: 1 }]} numberOfLines={1}>
                  {label}
                </Text>
                {on ? <Text style={styles.menuOk}>✓</Text> : null}
              </Pressable>
            );
          })}
        </View>
    ) : null;
  return (
    <Pressable style={styles.menuBackdrop} onPress={onClose}>
      {/* Swallow clicks so item presses don't bubble to the backdrop and close. */}
      <Pressable
        onPress={(e) => e.stopPropagation()}
        onLayout={pos.onLayout}
        style={[styles.rowMenuCard, { left: Math.max(12, menu.x - 190), top: pos.top }]}>
        {renaming ? (
          <View style={styles.renameField}>
            <TextInput
              ref={renameRef}
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={commitRename}
              onEndEditing={commitRename}
              style={styles.menuRenameInput}
              accessibilityLabel="Renomear categoria"
            />
            <View style={styles.renameRow}>
              {isGroup ? null : (
                <Pressable style={styles.menuItem} onPress={onHide ?? undefined} disabled={!onHide}>
                  <Text style={styles.menuItemText}>Ocultar</Text>
                </Pressable>
              )}
              <Pressable style={styles.menuItem} onPress={onDelete}>
                <Text style={styles.menuItemTextDanger}>Excluir</Text>
              </Pressable>
              <Pressable style={styles.menuItem} onPress={() => setRenaming(false)}>
                <Text style={styles.menuItemText}>Cancelar</Text>
              </Pressable>
              <Pressable style={styles.menuItem} onPress={commitRename}>
                <Text style={styles.menuOk}>OK</Text>
              </Pressable>
            </View>
            {bundleItems}
            {assignBlock}
          </View>
        ) : (
          <View>
            <Text style={styles.menuRowName}>{name}</Text>
            <Pressable style={styles.menuItem} onPress={onRename && !batch ? startRename : undefined} disabled={!onRename || batch}>
              <Text style={[styles.menuItemText, (!onRename || batch) && styles.viewsBtnDisabled]}>
                Renomear
              </Text>
            </Pressable>
            {onHide ? (
              <Pressable style={styles.menuItem} onPress={onHide}>
                <Text style={styles.menuItemText}>Ocultar</Text>
              </Pressable>
            ) : null}
            {bundleItems}
            {assignBlock}
            <Pressable style={styles.menuItem} onPress={onDelete}>
              <Text style={styles.menuItemTextDanger}>Excluir</Text>
            </Pressable>
          </View>
        )}
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  // xvu scope C: YNAB-parity toolbar row
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  toolbarAdd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.indigo2,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  toolbarAddText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  toolbarLink: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 6 },
  toolbarLinkText: { color: colors.indigo2, fontSize: 13, fontWeight: '600' },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  month: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  monthLabel: { color: colors.text, fontSize: 18, fontWeight: '800' },
  navm: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rta: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    backgroundColor: colors.rtaBg,
    borderWidth: 1,
    borderColor: colors.rtaBorder,
    borderRadius: radius.r,
    paddingVertical: 11,
    paddingHorizontal: 15,
  },
  rtaAmount: { color: colors.greenPillFg, fontSize: 22, fontWeight: '800' },
  rtaSub: { color: colors.rtaSub, fontSize: 12 },
  // ubgb: YNAB overspent banner — red strip directly under the topbar.
  rtaFixBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    backgroundColor: colors.redPillBg,
    borderWidth: 1,
    borderColor: colors.red,
    borderRadius: radius.r,
    paddingVertical: 10,
    paddingHorizontal: 15,
    marginBottom: 10,
  },
  rtaFixText: { color: colors.redFg, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  rtaFixAction: { color: colors.redFg, fontSize: 13, fontWeight: '800', textDecorationLine: 'underline' },
  chips: { paddingHorizontal: 20, marginBottom: 10, flexGrow: 0 },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 13,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  chipText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  thead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  theadText: { color: colors.faint, fontSize: 11, letterSpacing: 0.6 },
  colNum: PLAN_COLS.num,
  colAvail: PLAN_COLS.avail,
  // Phone: narrower ASSIGNED/AVAILABLE so the category name keeps room.
  colNumPhone: PLAN_COLS.numPhone,
  colAvailPhone: PLAN_COLS.availPhone,
  // Phone: the read-only assigned amount at desktop size wraps inside 92px.
  numTextPhone: { fontSize: 12 },
  // Phone: the numpad's live equation lines (blue, YNAB parity) in the row's
  // ASSIGNED cell; the trailing '|' is the caret.
  numpadEditLine: { color: colors.indigo3, fontWeight: '700' },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 11,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  groupName: { color: colors.text, fontWeight: '700', fontSize: 14 },
  groupTotal: { color: colors.text, fontWeight: '700', fontSize: 13, fontVariant: ['tabular-nums'] },
  trow: {
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  trowSelected: { backgroundColor: colors.indigoSoft },
  trowChecked: { backgroundColor: colors.indigoSoft },
  // Bundle child: indented under its bundle row with a tree line.
  trowChild: { marginLeft: 30, borderLeftWidth: 2, borderLeftColor: colors.border2, paddingLeft: 14 },
  trowBundleTarget: { borderWidth: 2, borderStyle: 'dashed', borderColor: colors.indigo3, backgroundColor: colors.indigoSoft },
  bundleDropChip: {
    position: 'absolute',
    left: 300,
    top: 6,
    zIndex: 41,
    backgroundColor: colors.indigo,
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  bundleDropChipText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  trowDragging: {
    backgroundColor: colors.card2,
    opacity: 0.88,
    userSelect: 'none',
    zIndex: 30,
    elevation: 12,
  },
  selBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    borderTopRightRadius: 2,
    borderBottomRightRadius: 2,
    backgroundColor: colors.indigo,
  },
  dropLine: {
    position: 'absolute',
    left: 14,
    right: 14,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.indigo2,
    zIndex: 40,
  },
  dropTop: { top: -2 },
  dropBottom: { bottom: -2 },
  checkCell: { marginRight: 10 },
  checkbox: {
    width: 17,
    height: 17,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.faint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  checkMark: { color: '#fff', fontSize: 11, fontWeight: '800', marginTop: -1 },
  checkboxHidden: { opacity: 0 },
  trowInner: { flexDirection: 'row', alignItems: 'center' },
  catName: { color: colors.text, fontWeight: '600', fontSize: 14, flexShrink: 1 },
  catHint: { fontSize: 11, marginTop: 1 },
  catNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  catNameShared: { color: colors.muted, fontWeight: '500' },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  numText: { color: colors.text, fontSize: 14, fontVariant: ['tabular-nums'], textAlign: 'right' },
  menuSubhead: { color: colors.faint, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 },
  menuPersonRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  summaryScope: { color: colors.indigo3, fontSize: 12, fontWeight: '700', marginBottom: 8, marginTop: -4 },
  summaryPanel: {
    width: 280,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    backgroundColor: colors.card2,
  },
  summaryTitle: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 12 },
  summaryCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: 13,
    marginBottom: 12,
  },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  kvLabel: { color: colors.muted, fontSize: 13 },
  kvValue: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  noteInput: { color: colors.text, fontSize: 13, minHeight: 60, textAlignVertical: 'top', padding: 0 },
  viewsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  viewsBtnText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  viewsCard: {
    position: 'absolute',
    top: 44,
    right: 16,
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
    minWidth: 220,
  },
  menuBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40 },
  recentCard: { position: 'absolute', right: undefined, minWidth: 300, maxWidth: 380 },
  recentRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  recentAge: { color: colors.muted, fontSize: 11 },
  viewsBtnDisabled: { color: colors.muted },
  menuItem: { paddingVertical: 9, paddingHorizontal: 14 },
  menuItemText: { color: colors.text, fontSize: 13 },
  menuItemTextDanger: { color: colors.redFg, fontSize: 13 },
  menuTitle: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 2,
  },
  rowMenuBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  rowMenuText: { color: colors.muted, fontSize: 14 },
  // xvu: self-contained card (NOT layered over viewsCard — its right:16 would
  // combine with an inline left and stretch the popover full-width). Fixed
  // width; each call site passes its own left/top or right/top anchor.
  rowMenuCard: {
    position: 'absolute',
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
    width: 200,
  },
  // 4rr: header Assign dropdown card (child of the menuBackdrop).
  assignCard: {
    position: 'absolute',
    zIndex: 41,
    width: 340,
    maxHeight: 480,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: 12,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
  },
  // pjtv: YNAB move/cover popover anchored under the pill (child of menuBackdrop).
  pillPopCard: {
    position: 'absolute',
    zIndex: 41,
    width: 300,
    maxHeight: 420,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: 8,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
  },
  menuRowName: {
    color: colors.text,
    fontWeight: '700',
    fontSize: 14,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 2,
  },
  renameField: { paddingVertical: 4, paddingHorizontal: 8, gap: 4 },
  menuRenameInput: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    borderWidth: 1.5,
    borderColor: colors.indigo,
    borderRadius: radius.sm,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  renameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 4 },
  menuOk: { color: colors.indigo2, fontSize: 13, fontWeight: '700' },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  addRowText: { color: colors.muted, fontSize: 13 },
  addRowInput: { flex: 1, color: colors.text, fontSize: 13, padding: 0 },
  renameInput: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
});
