/**
 * Move-money flow (tasks 5.4) — opened from an available pill, the RTA
 * banner's Assign button, or the inspector's Cover Overspending action.
 *
 * YNAB parity (syscd-app-aey): one amount input, the fixed FROM source shown
 * as a read-only row, ONE searchable "To" select (type-ahead over Ready to
 * Assign + categories grouped by category group, built on the shared
 * register DropdownShell portal), and a Cancel / OK footer.
 *
 * Moves an amount from `from` (a category, or null = Ready-to-Assign) to a
 * picked destination (a category, or Ready-to-Assign). Persists both resulting
 * absolute assigned values via `applyAssignmentUpdates` (ledger helper).
 *
 * Two presentations share the confirm logic (`useMoveMoney`):
 * - `MoveMoneyBody` in a centered OverlaySheet (native; the sheet's amount
 *   input stays editable before confirming).
 * - `MoveMoneyPopover` (syscd-app-ubgb) — the minimal YNAB anchored form on
 *   web: Move = amount input (prefilled + selected) + "To" dropdown;
 *   Cover = "Cover overspending from" + empty source dropdown;
 *   Un-assign (negative RTA) = "Un-assign money from" + empty source dropdown.
 *   Cover/Un-assign compute the amount at confirm time, like YNAB.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import { useAppDispatch } from '@/state/hooks';

import { useApplyAssignmentUpdatesMutation } from '@/budget/data/api';
import { multiMoveMoneyUpdates, type MovePair } from '@/budget/data/ledger';
import { categoryLabel } from '@/domain/bundles';
import { useBudgetMonth } from '@/state/useBudgetMonth';
import { categoryFigures, type BudgetMonth } from '@/domain/zeroSum';
import { useMoneyFormat } from '@/ui/moneyFormat';
import type { Budget, Bundle, Cents, Category, CategoryGroup, MonthKey } from '@/domain/types';
import { makeMultiMoveEdit, newPlanEdit } from '@/state/planEdits';
import { recordPlanEdit } from '@/state/ui';
import { GhostButton, IndigoButton, MoneyInput, OverlaySheet, SheetItem } from '@/ui/bits';
import { colors } from '@/ui/theme';
import { buildCategoryPickItems, type CategoryPickItem } from '@/ui/categoryPick';
import { amountStyle, DropdownShell, dropdownStyles, useDropdownPortal, type DropdownKeyEvent } from '@/ui/dropdown/dropdown';

export interface MoveMoneyRequest {
  /** Source category id, or null to assign out of Ready-to-Assign. */
  from: string | null;
  /** Preset destination (cover-overspending); user picks when undefined. */
  to?: string | null;
  /** Cover mode: `to` is the overspent category (fixed row) and `from` is the
   * picked covering source — YNAB's "Cover overspending from" dialog. */
  pickFrom?: boolean;
  /** Un-assign mode (syscd-app-ubgb): `from` is picked in the dialog and the
   * money goes back to Ready-to-Assign; the amount is computed at confirm
   * (min(needed, available)). Used by the negative-RTA "Fix This" banner. */
  unassign?: boolean;
}


/**
 * Searchable "To" select for the Move Money sheet (syscd-app-aey). One input,
 * type-ahead filter, Ready to Assign row (hidden when RTA is the source) then
 * one section per category group — same visual language as the register
 * CategoryDropdown, on the shared portal shell.
 */
export function ToDropdown({
  categories,
  groups,
  bundles = [],
  fromId,
  selectedTo,
  readyToAssign,
  bm,
  onPick,
  placeholder,
}: {
  categories: Category[];
  groups: CategoryGroup[];
  bundles?: Bundle[];
  /** Source category id — excluded as a destination (can't move onto itself). */
  fromId: string | null;
  selectedTo: string | null | undefined;
  readyToAssign: Cents;
  /** The engine's figures for the viewed month (Available next to each row). */
  bm: BudgetMonth;
  onPick: (to: string | null) => void;
  /** Shown while nothing is picked (undefined → default hint). An empty
   * string gives YNAB's blank-until-picked dropdown. */
  placeholder?: string;
}) {
  const { formatMoney } = useMoneyFormat();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [highlight, setHighlight] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const { containerRef, anchor, blurClose } = useDropdownPortal(open, close);

  const current = selectedTo ? categories.find((c) => c.id === selectedTo) ?? null : null;
  const query = draft.trim().toLowerCase();
  const inputValue = open && draft !== '' ? draft : (current ? categoryLabel(current, bundles) : undefined) ?? (selectedTo === null ? 'Ready to Assign' : '');

  const items = useMemo<CategoryPickItem[]>(
    () =>
      buildCategoryPickItems({
        categories,
        groups,
        bundles,
        query,
        excludeId: fromId,
        selectedId: selectedTo,
        pinSelected: true,
        rta: fromId !== null,
      }),
    [fromId, selectedTo, groups, categories, bundles, query],
  );

  const commit = useCallback(
    (item: CategoryPickItem | undefined) => {
      if (!item) return;
      onPick(item.categoryId);
      close();
    },
    [onPick, close],
  );

  const onKeyPress = useCallback(
    (e: DropdownKeyEvent) => {
      const key = e.nativeEvent.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        if (!open) {
          setDraft('');
          setHighlight(0);
          setOpen(true);
          return;
        }
        setHighlight((h) => (key === 'ArrowDown' ? Math.min(h + 1, items.length - 1) : Math.max(h - 1, 0)));
      } else if (key === 'Enter' && open) {
        e.preventDefault();
        commit(items[highlight]);
      } else if (key === 'Escape' && open) {
        e.preventDefault();
        close();
      }
    },
    [open, items, highlight, commit, close],
  );

  const rows: ReactNode[] = [];
  let lastTitle: string | null = null;
  items.forEach((item, i) => {
    if (item.key === '__selected__') {
      rows.push(
        <Text key="selected-hd" style={dropdownStyles.sectionTitle}>
          Selected
        </Text>,
      );
    }
    if (item.groupTitle && lastTitle !== item.groupTitle) {
      lastTitle = item.groupTitle;
      rows.push(
        <Text key={item.groupTitle} style={dropdownStyles.sectionTitle}>
          {item.groupTitle.toUpperCase()}
        </Text>,
      );
    }
    const pinned = item.key === '__selected__' || item.key === '__rta__';
    const cat = item.categoryId ? (categories.find((c) => c.id === item.categoryId) ?? null) : null;
    rows.push(
      <Pressable
        key={item.key}
        onPressIn={() => commit(item)}
        // Web portals mount on document.body; RN-web's Pressable responder
        // doesn't engage for clicks inside OverlaySheet's Modal portal, so
        // commit on the native pointerdown directly (syscd-app-aey).
        onPointerDown={() => commit(item)}
        onHoverIn={() => setHighlight(i)}
        accessibilityRole="button"
        accessibilityLabel={`Pick ${item.label} as destination`}
        style={[dropdownStyles.row, (pinned || i === highlight) && dropdownStyles.rowActive]}>
        {item.checked ? <Text style={dropdownStyles.check}>✓</Text> : <Text style={dropdownStyles.checkPlaceholder} />}
        <Text style={dropdownStyles.rowLabel} numberOfLines={1}>
          {item.label}
        </Text>
        {cat ? (
          <Text style={[dropdownStyles.rowAmount, amountStyle(categoryFigures(bm, cat.id).available)]}>
            {formatMoney(categoryFigures(bm, cat.id).available)}
          </Text>
        ) : (
          <Text style={[dropdownStyles.rowAmount, amountStyle(readyToAssign)]}>{formatMoney(readyToAssign)}</Text>
        )}
      </Pressable>,
    );
  });
  if (query && items.length === 0) {
    rows.push(
      <Text key="empty" style={dropdownStyles.emptyRow}>
        No categories match “{draft.trim()}”
      </Text>,
    );
  }

  return (
    <View ref={containerRef} style={styles.toCell}>
      <DropdownShell
        open={open}
        anchor={anchor}
        value={inputValue}
        onChangeText={(t) => {
          setDraft(t);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => {
          setDraft('');
          setHighlight(0);
          setOpen(true);
        }}
        onBlur={blurClose}
        onKeyPress={onKeyPress}
        accessibilityLabel="Move money destination"
        placeholder={selectedTo === undefined ? placeholder ?? 'Pick a destination…' : undefined}
        chevron
        portalMinWidth={240}
        portalMaxHeight={280}
        nativeMaxHeight={280}>
        {rows}
      </DropdownShell>
    </View>
  );
}

/**
 * Shared confirm logic for the move/cover/un-assign form. Seeds from
 * `request` in the state initializers (mounts fresh per open, so no
 * visible-reset effect) and exposes the amount the footer's OK should apply:
 * Move uses the entered amount; Cover covers the whole shortfall and
 * Un-assign pulls back min(needed, available) — YNAB semantics.
 */
// Exported for the mobile full-screen move flow (MobileMoveMoney), which
// reuses this confirm/persistence logic with its own YNAB-style UI.
export function useMoveMoney({
  budget,
  budgetId,
  month,
  request,
  onClose,
}: {
  budget: Budget;
  budgetId: string;
  month: MonthKey;
  request: MoveMoneyRequest;
  onClose: () => void;
}) {
  const { formatMoney } = useMoneyFormat();
  const [apply, applyState] = useApplyAssignmentUpdatesMutation();
  const dispatch = useAppDispatch();
  const cover = request.pickFrom === true && request.to != null;
  const unassign = request.unassign === true;
  const [to, setTo] = useState<string | null | undefined>(request.to);
  // Cover/Un-assign mode: the source starts UNPICKED — YNAB shows an empty
  // dropdown. Move mode: `from` is the fixed source (null = Ready-to-Assign).
  const [fromPick, setFromPick] = useState<string | null | undefined>(
    cover || unassign ? undefined : request.from,
  );
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const fromCat = request.from ? budget.categories.find((c) => c.id === request.from) : null;
  const bm = useBudgetMonth(budget, month);
  const readyToAssign = bm.readyToAssign;
  const availableOf = (c: Category): Cents => categoryFigures(bm, c.id).available;
  const toCat = request.to != null ? budget.categories.find((c) => c.id === request.to) ?? null : null;

  // Seed the amount once: move-from-RTA starts at RTA, cover starts at the
  // shortfall. (Hooks mount fresh per open, so the initializer is enough.)
  const [amount, setAmount] = useState<Cents>(() => {
    if (unassign || cover) return 0;
    return fromCat ? Math.max(0, availableOf(fromCat)) : Math.max(0, readyToAssign);
  });

  /** Amount the OK button applies (cover/un-assign compute; move uses input). */
  const smartAmount = (): Cents | null => {
    if (unassign) {
      const pick = fromPick ? budget.categories.find((c) => c.id === fromPick) ?? null : null;
      if (!pick) return null;
      return Math.min(Math.max(0, -readyToAssign), Math.max(0, availableOf(pick)));
    }
    if (cover && toCat) return Math.max(0, -availableOf(toCat));
    return amount;
  };

  const valid =
    !applyState.isLoading &&
    (unassign
      ? fromPick != null && (smartAmount() ?? 0) > 0
      : cover
        ? fromPick !== undefined && (smartAmount() ?? 0) > 0
        : to !== undefined && amount > 0);

  /**
   * One persistence path for every presentation (sheet, popover, mobile
   * full-screen): applies the pairs as absolute assignment updates and
   * records ONE undoable plan edit for the whole batch.
   */
  const confirmPairs = async (pairs: readonly MovePair[]) => {
    if (applyState.isLoading) return;
    const updates = multiMoveMoneyUpdates(budget, month, pairs);
    if (!updates.length) return;
    setConfirmError(null);
    try {
      await apply({ budgetId, month, updates }).unwrap();
      // Snapshot over the pre-mutation `budget` prop; persisting already succeeded.
      const draft = makeMultiMoveEdit(budget, budgetId, month, pairs, { formatMoney });
      if (draft) dispatch(recordPlanEdit(newPlanEdit(draft)));
      onClose();
    } catch (err) {
      setConfirmError(apiErrorMessage(err, 'failed to move money'));
    }
  };

  const confirm = async (override?: Cents) => {
    const amt = override ?? amount;
    if (amt <= 0 || applyState.isLoading) return;
    if (unassign) {
      if (fromPick == null) return;
    } else if (to === undefined) {
      return;
    }
    const effectiveFrom: string | null = unassign ? (fromPick ?? null) : cover ? (fromPick ?? null) : request.from;
    const effectiveTo: string | null = unassign ? null : (to ?? null);
    await confirmPairs([{ from: effectiveFrom, to: effectiveTo, amount: amt }]);
  };

  return {
    applyState,
    cover,
    unassign,
    to,
    setTo,
    fromPick,
    setFromPick,
    amount,
    setAmount,
    readyToAssign,
    bm,
    fromCat,
    toCat,
    confirm,
    confirmPairs,
    smartAmount,
    valid,
    confirmError,
  };
}

/**
 * Shared move/cover form (syscd-app-aey): one amount input, the fixed FROM
 * row, ONE searchable destination/source select and a Cancel/OK footer.
 * Native keeps the centered OverlaySheet; web pill presses open the minimal
 * `MoveMoneyPopover` instead.
 */
export function MoveMoneyBody({
  budget,
  budgetId,
  month,
  request,
  onClose,
}: {
  budget: Budget;
  budgetId: string;
  month: MonthKey;
  request: MoveMoneyRequest;
  onClose: () => void;
}) {
  const { formatMoney } = useMoneyFormat();
  const m = useMoveMoney({ budget, budgetId, month, request, onClose });

  const fromLabel = m.fromCat ? categoryLabel(m.fromCat, budget.bundles) : 'Ready to Assign';
  const fromAvailable = m.fromCat ? categoryFigures(m.bm, m.fromCat.id).available : m.readyToAssign;
  const title = m.unassign
    ? 'UN-ASSIGN MONEY · TO READY TO ASSIGN'
    : m.cover && m.toCat
      ? `COVER OVERSPENDING · ${categoryLabel(m.toCat, budget.bundles).toUpperCase()}`
      : `MOVE MONEY · FROM ${fromLabel.toUpperCase()}`;

  return (
    <>
      <Text style={styles.bodyTitle}>{title}</Text>
      {m.unassign ? null : (
        <View style={styles.amountRow}>
          <Text style={styles.amountLabel}>Amount</Text>
          <MoneyInput cents={m.amount} onCommit={m.setAmount} />
        </View>
      )}
      {m.unassign ? (
        <View style={styles.unassignRow}>
          <ToDropdown
            categories={budget.categories}
            groups={budget.groups}
            bundles={budget.bundles}
            fromId={null}
            selectedTo={m.fromPick === undefined ? undefined : m.fromPick}
            readyToAssign={m.readyToAssign}
            bm={m.bm}
            onPick={m.setFromPick}
            placeholder=""
          />
        </View>
      ) : m.cover && m.toCat ? (
        <>
          <SheetItem icon="↘" label="Cover" sub={`${categoryLabel(m.toCat, budget.bundles)} · ${formatMoney(categoryFigures(m.bm, m.toCat.id).available)}`} />
          <View style={styles.toRow}>
            <Text style={styles.amountLabel}>From</Text>
            <ToDropdown
              categories={budget.categories}
              groups={budget.groups}
              bundles={budget.bundles}
              fromId={request.to ?? null}
              selectedTo={m.fromPick ?? null}
              readyToAssign={m.readyToAssign}
              bm={m.bm}
              onPick={m.setFromPick}
            />
          </View>
          {categoryFigures(m.bm, m.toCat.id).kind === 'payment' && categoryFigures(m.bm, m.toCat.id).available < 0 ? (
            <Text style={styles.coverWarning} accessibilityRole="alert">
              Your credit card payment was greater than what you had available in your category. Why?
            </Text>
          ) : null}
        </>
      ) : (
        <>
          <SheetItem icon="↗" label="From" sub={`${fromLabel} · ${formatMoney(fromAvailable)}`} />
          <View style={styles.toRow}>
            <Text style={styles.amountLabel}>To</Text>
            <ToDropdown
              categories={budget.categories}
              groups={budget.groups}
              bundles={budget.bundles}
              fromId={request.from}
              selectedTo={m.to}
              readyToAssign={m.readyToAssign}
              bm={m.bm}
              onPick={m.setTo}
            />
          </View>
        </>
      )}
      <View style={styles.footer}>
        <View style={styles.footerBtn}>
          <GhostButton label="Cancel" onPress={onClose} />
        </View>
        <View style={styles.footerBtn}>
          <IndigoButton
            label="OK"
            onPress={m.valid ? () => void m.confirm(m.smartAmount() ?? undefined) : undefined}
            style={m.valid ? undefined : styles.btnDimmed}
          />
        </View>
      </View>
      {m.confirmError ? (
        <Text style={styles.confirmError} accessibilityRole="alert">
          {m.confirmError}
        </Text>
      ) : null}
    </>
  );
}

/**
 * Minimal YNAB anchored form (syscd-app-ubgb) — same words as YNAB, nothing
 * more: Move = amount input (prefilled + selected) + "To" dropdown;
 * Cover = "Cover overspending from" + empty source dropdown; Un-assign =
 * "Un-assign money from" + empty source dropdown. Cancel / OK footer.
 */
export function MoveMoneyPopover({
  budget,
  budgetId,
  month,
  request,
  onClose,
}: {
  budget: Budget;
  budgetId: string;
  month: MonthKey;
  request: MoveMoneyRequest;
  onClose: () => void;
}) {
  const m = useMoveMoney({ budget, budgetId, month, request, onClose });

  const onOk = () => {
    const amt = m.smartAmount();
    if (amt != null && amt > 0) void m.confirm(amt);
  };

  return (
    <>
      <Text style={styles.popTitle}>
        {m.cover ? 'Cover overspending from' : m.unassign ? 'Un-assign money from' : 'Move'}
      </Text>
      {!m.cover && !m.unassign ? (
        <View style={styles.popAmount}>
          <MoneyInput cents={m.amount} onCommit={m.setAmount} autoFocus />
        </View>
      ) : null}
      {m.cover || m.unassign ? (
        <View style={styles.popWide}>
          <ToDropdown
            categories={budget.categories}
            groups={budget.groups}
            bundles={budget.bundles}
            fromId={m.cover ? request.to ?? null : null}
            selectedTo={m.fromPick === undefined ? undefined : m.fromPick}
            readyToAssign={m.readyToAssign}
            bm={m.bm}
            onPick={m.setFromPick}
            placeholder=""
          />
        </View>
      ) : (
        <View style={styles.popToRow}>
          <Text style={styles.amountLabel}>To</Text>
          <ToDropdown
            categories={budget.categories}
            groups={budget.groups}
            bundles={budget.bundles}
            fromId={request.from}
            selectedTo={m.to}
            readyToAssign={m.readyToAssign}
            bm={m.bm}
            onPick={m.setTo}
            placeholder=""
          />
        </View>
      )}
      <View style={styles.footer}>
        <View style={styles.footerBtn}>
          <GhostButton label="Cancel" onPress={onClose} />
        </View>
        <View style={styles.footerBtn}>
          <IndigoButton label="OK" onPress={m.valid ? onOk : undefined} style={m.valid ? undefined : styles.btnDimmed} />
        </View>
      </View>
      {m.confirmError ? (
        <Text style={styles.confirmError} accessibilityRole="alert">
          {m.confirmError}
        </Text>
      ) : null}
    </>
  );
}

export function MoveMoneySheet({
  visible,
  onClose,
  budget,
  budgetId,
  month,
  request,
}: {
  visible: boolean;
  onClose: () => void;
  budget: Budget;
  budgetId: string;
  month: MonthKey;
  request: MoveMoneyRequest;
}) {
  // Native presentation. On web the pill opens MoveMoneyPopover in an anchored
  // popover instead (PlanScreen pillPop). Rendering nothing while closed (and
  // the parent rendering this only when open) keeps the body fresh per open.
  if (!visible) return null;
  return (
    <OverlaySheet visible onClose={onClose}>
      <MoveMoneyBody budget={budget} budgetId={budgetId} month={month} request={request} onClose={onClose} />
    </OverlaySheet>
  );
}

const styles = StyleSheet.create({
  // Same look OverlaySheet gave its `title` prop before the body was extracted.
  bodyTitle: {
    fontSize: 10,
    color: colors.faint,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    paddingHorizontal: 11,
    paddingTop: 9,
    paddingBottom: 5,
    fontWeight: '700',
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  amountLabel: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  toRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  toCell: { position: 'relative', zIndex: 30, flex: 1 },
  unassignRow: { position: 'relative', zIndex: 30, paddingHorizontal: 11, paddingVertical: 8 },
  // Minimal popover (syscd-app-ubgb): muted title, blank-until-picked dropdown.
  popTitle: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
  },
  popAmount: { paddingHorizontal: 14, paddingBottom: 10 },
  popToRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  popWide: { position: 'relative', zIndex: 30, paddingHorizontal: 14, paddingBottom: 12 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 11,
    paddingTop: 4,
  },
  footerBtn: { minWidth: 96 },
  btnDimmed: { opacity: 0.45 },
  coverWarning: { color: colors.muted, fontSize: 12, marginTop: 6, paddingHorizontal: 11, lineHeight: 17 },
  confirmError: { color: colors.redFg, fontSize: 12, marginTop: 6, paddingHorizontal: 11, paddingBottom: 8 },
});
