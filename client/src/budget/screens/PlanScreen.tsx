/**
 * Plan — the assign-to-categories screen (spec: budget-screens; tasks 5.x).
 *
 * SectionList of category groups → categories with ASSIGNED / ACTIVITY /
 * AVAILABLE, the Ready-to-Assign banner, filter chips, inline assigned
 * editing, funding-state pills + progress bars, the move-money flow, the
 * category inspector (panel/slide-over) and the month summary when nothing is
 * selected. All derived values come from the domain engine, every change goes
 * through `budgetApi` mutations.
 *
 * This file composes the screen; its state lives in the hooks under
 * screens/plan/ (selection, drag, menus, numpad, undo, …), its parts are the
 * components there, and the row / filter / drop math is domain/plan*.ts.
 */

import { useMemo, useRef, type ComponentRef } from 'react';
import { ActivityIndicator, Pressable, SectionList, Text, View, type ViewInstance } from 'react-native';

import { useAppDispatch, useAppSelector } from '@/store/hooks';

import { PERSON_ALL } from '../domain/people';
import { buildPlanSections, dropRowOrder, planItemKey } from '../domain/planSections';
import { useBudgetModel } from '../model/useBudgetModel';
import { useBudgetMonth } from '../model/useBudgetMonth';
import { useMoneyFormat } from '../model/useDisplayPrefs';
import { usePersonFilter } from '../model/usePersonFilter';
import {
  selectActiveMonth,
  selectCategory,
  selectPlanFilter,
  selectSelectedCategoryId,
  selectShowProgressBars,
} from '../state/ui';
import { colors } from '../ui/theme';
import { SelectionBar } from './BundleMenus';
import { isBundleItem } from './BundleRow';
import { CategoryInspector } from './CategoryInspector';
import { PersonFilterBar, planCaption } from './PersonFilterBar';
import { InlineAddRow } from './plan/InlineAddRow';
import { MonthSummary } from './plan/MonthSummary';
import { PlanBundleRow } from './plan/PlanBundleRow';
import { PlanCategoryRow } from './plan/PlanCategoryRow';
import { PlanGroupHeader } from './plan/PlanGroupHeader';
import { PlanListFooter } from './plan/PlanListFooter';
import { PlanMenus } from './plan/PlanMenus';
import { PlanOverlays } from './plan/PlanOverlays';
import { PlanToolbar } from './plan/PlanToolbar';
import { PlanTopbar } from './plan/PlanTopbar';
import { styles } from './plan/styles';
import type { AnchorAt, PlanGrid } from './plan/types';
import { useCollapsedGroups } from './plan/useCollapsedGroups';
import { useHiddenSection } from './plan/useHiddenSection';
import { usePlanAdd } from './plan/usePlanAdd';
import { usePlanDrag } from './plan/usePlanDrag';
import { usePlanNumpad } from './plan/usePlanNumpad';
import { usePlanOverlays } from './plan/usePlanOverlays';
import { usePlanRowMenus } from './plan/usePlanRowMenus';
import { usePlanSelection } from './plan/usePlanSelection';
import { usePlanUndo } from './plan/usePlanUndo';
import { useBudgetShell } from './shell';
import { useBundleActions } from './useBundleActions';

export function PlanScreen() {
  const { formatMoney } = useMoneyFormat();
  const dispatch = useAppDispatch();
  const shell = useBudgetShell();
  const { budget, budgetId, isLoading, error } = useBudgetModel();
  const byPerson = usePersonFilter(budget, budgetId, { activity: true });
  const month = useAppSelector((s) => selectActiveMonth(s));
  const bm = useBudgetMonth(budget, month);
  const filter = useAppSelector((s) => selectPlanFilter(s));
  const selectedId = useAppSelector((s) => selectSelectedCategoryId(s));
  const showProgressBars = useAppSelector((s) => selectShowProgressBars(s));
  const screenRef = useRef<ViewInstance>(null);
  const rowRefs = useRef(new Map<string, ComponentRef<typeof Pressable>>());
  const pillRefs = useRef(new Map<string, ComponentRef<typeof View>>());

  // All screen state sits above the early-loading return, so it survives a
  // reload of the budget. Bundles: expand state, drop/create/join actions.
  const bundleApi = useBundleActions(budget, budgetId);
  const groups = useCollapsedGroups();
  const selection = usePlanSelection(budgetId, month);
  const add = usePlanAdd(budget, budgetId, bundleApi, groups.expandGroup);
  const overlays = usePlanOverlays();
  const numpad = usePlanNumpad(shell.setNumpadOpen, rowRefs);
  const undo = usePlanUndo(budget, budgetId, month);
  const menus = usePlanRowMenus(budget, budgetId, bm, selection);
  const hidden = useHiddenSection(budget, budgetId, bm);

  const sections = useMemo(
    () =>
      budget
        ? buildPlanSections({
            budget,
            bm,
            filter,
            person: byPerson.person,
            activity: byPerson.activity,
            collapsed: groups.collapsed,
            expandedBundles: bundleApi.expanded,
            addCatGroup: add.addCatGroup,
            addCatBundle: add.addCatBundle,
          })
        : [],
    [budget, bm, filter, groups.collapsed, add.addCatGroup, add.addCatBundle, byPerson.person, byPerson.activity, bundleApi.expanded],
  );
  /** Drop-target row keys in display order (category ids and `bundle:<id>`). */
  const rowOrder = useMemo(() => dropRowOrder(sections), [sections]);
  const drag = usePlanDrag({ isDesktop: shell.isDesktop, rowOrder, rowRefs, onDrop: bundleApi.drop });

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

  const selected = selectedId ? budget.categories.find((c) => c.id === selectedId) : undefined;
  const { checkedRows } = selection;

  // Menus are absolutely positioned inside this screen's root, whose offset
  // parent is the budget content shell — pageX alone mis-anchors at desktop
  // width. Convert a page point into screen-root space at press time (same
  // measureInWindow pattern as the 4rr Assign button).
  const anchorAt: AnchorAt = (pageX, pageY, cb) => {
    screenRef.current?.measureInWindow((sx, sy) => cb(pageX - sx, pageY - sy));
  };

  const grid: PlanGrid = {
    budget,
    budgetId,
    bm,
    month,
    shell,
    byPerson,
    selectedId,
    showActivity: !shell.isPhone,
    phoneActivity: shell.isPhone && byPerson.person !== PERSON_ALL,
    showProgressBars,
    selection,
    drag,
    menus,
    add,
    numpad,
    overlays,
    undo,
    groups,
    bundleApi,
    anchorAt,
    rowRefs,
    pillRefs,
  };

  return (
    <View ref={screenRef} style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
      <PlanTopbar grid={grid} />
      <PlanToolbar grid={grid} />

      <PersonFilterBar byPerson={byPerson} budgetId={budgetId} caption={planCaption(byPerson)} showOwnsNoneHint />

      <View style={{ flex: 1, flexDirection: 'row' }}>
        <View style={{ flex: 1 }}>
          {checkedRows.size >= 2 ? (
            <SelectionBar
              count={checkedRows.size}
              onClear={selection.clearChecked}
              onBundle={(px, py) => anchorAt(px, py, (x, y) => menus.setBundlePop({ x, y, ids: [...checkedRows] }))}
            />
          ) : null}
          {/* table header */}
          <View style={styles.thead}>
            <Text style={[styles.theadText, { flex: 1 }]}>CATEGORY</Text>
            <Text style={[styles.theadText, styles.colNum, shell.isPhone && styles.colNumPhone]}>{grid.phoneActivity ? 'ACTIVITY' : 'ASSIGNED'}</Text>
            {grid.showActivity ? <Text style={[styles.theadText, styles.colNum]}>ACTIVITY</Text> : null}
            <Text style={[styles.theadText, styles.colAvail, shell.isPhone && styles.colAvailPhone]}>AVAILABLE</Text>
          </View>
          <SectionList
            sections={sections}
            keyExtractor={(c) => planItemKey(c)}
            stickySectionHeadersEnabled={false}
            ref={numpad.planListRef}
            scrollEventThrottle={16}
            onScroll={numpad.onListScroll}
            ListFooterComponent={() => <PlanListFooter grid={grid} hidden={hidden} formatMoney={formatMoney} />}
            renderSectionHeader={({ section }) => <PlanGroupHeader grid={grid} group={section.group} />}
            renderItem={({ item: c, section }) => {
              if (typeof c === 'string') {
                return (
                  <InlineAddRow
                    placeholder="Category name"
                    accessibilityLabel="New category name"
                    onCommit={(name) => add.commitAddCategory(section.group.id, name)}
                    onCancel={add.cancelAddCategory}
                  />
                );
              }
              if (isBundleItem(c)) return <PlanBundleRow grid={grid} item={c} />;
              return <PlanCategoryRow grid={grid} category={c} />;
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
            onMoveMoney={(req) => overlays.setMoveReq(req)}
            onAutoAssign={() => overlays.setAutoAssignOpen(true)}
          />
        ) : null}
      </View>

      <PlanOverlays grid={grid} />
      <PlanMenus grid={grid} />
    </View>
  );
}
