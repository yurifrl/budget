/**
 * Accounts — account list with cleared/uncleared/working balances (Cash /
 * Credit / Closed), the virtualized transaction register (columns, category
 * pill, cleared indicator, approve queue) and the YNAB-parity reconcile flow
 * (header entry → confirm popover → live-difference banner → adjustment, with
 * reconciled rows locked and hidden by default).
 *
 * This file is the composition root: state lives in the hooks under
 * `./accounts/` (filter, selection, reconcile session, toast, bank sync) and
 * the pure rules in `domain/register*.ts`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  type ViewInstance,
} from "react-native";

import { useLocalSearchParams } from "expo-router";

import { useUpdateTransactionMutation } from "@/budget/data/api";
import { AccountEditModal } from "./AccountEditModal";
import { workingBalance } from "@/domain/engine";
import { todayIso } from "@/domain/format";
import { useMoneyFormat } from '@/ui/moneyFormat';
import type { Transaction } from "@/domain/types";
import { futureInstallmentsTotal, registerRunningBalances, scopeBalances } from "@/domain/register";
import { colors, radius } from "@/ui/theme";
import { usePeople } from "@/features/people";
import { useBudgetModel } from "@/state/useBudgetModel";
import { useBudgetShell } from "@/shell/context";
import { AccountHeader } from "./AccountHeader";
import { ApprovalBanner } from "./ApprovalBanner";
import { AccountsToolbar } from "./AccountsToolbar";
import { ReconcileBanner, ReconcilePopover } from "./ReconcilePanels";
import { RegisterList } from "./RegisterList";
import { RegisterHeader } from "./RegisterRow";
import { SelectionBar } from "./SelectionBar";
import { useAccountSync } from "./useAccountSync";
import { useAccountsToast } from "./useAccountsToast";
import { useReconcileSession } from "./useReconcileSession";
import { useRegisterFilter } from "./useRegisterFilter";
import { useRegisterSelection } from "./useRegisterSelection";
import { InlineAddRow } from "./register/InlineAddRow";
import { TxnRowMenu } from "./register/TxnRowMenu";

export function AccountsScreen() {
  const { parseMoney } = useMoneyFormat();
  const shell = useBudgetShell();
  const { budget, budgetId, error } = useBudgetModel();
  // Selection lives in the URL: the shell rail's account rows navigate with
  // ?account=<id>; no param = All Accounts. `edit=1` deep-links straight into
  // the account editor (the Add-Account bank path lands here).
  const { account: accountParam, linked: linkedParam, edit: editParam } = useLocalSearchParams<{
    account?: string;
    linked?: string;
    edit?: string;
  }>();
  const selectedAccountId = accountParam ?? null;
  const screenRef = useRef<ViewInstance>(null);
  // Menus are absolutely positioned inside this screen's root, whose offset
  // parent is the budget content shell — pageX alone mis-anchors at desktop
  // width. Convert a page point into screen-root space at press time.
  const anchorAt = (
    pageX: number,
    pageY: number,
    cb: (x: number, y: number) => void,
  ) => {
    screenRef.current?.measureInWindow((sx, sy) => cb(pageX - sx, pageY - sy));
  };
  const [updateTransaction] = useUpdateTransactionMutation();
  const { accountRows, syncStatus } = useAccountSync(budgetId, selectedAccountId);

  // Hooks must precede the loading guard below (rules of hooks): `budget` is
  // optional-chained and the hooks tolerate a budget that is still loading.
  const filter = useRegisterFilter({ budget, selectedAccountId, parseMoney });
  const { transactions, registerTxns, scheduledTxns } = filter;

  const [inlineAddOpen, setInlineAddOpen] = useState(false);
  const [editingTxnId, setEditingTxnId] = useState<string | null>(null);
  // Row context menu (syscd-app-42f): kebab click / right-click opens the
  // YNAB transaction menu for that row.
  const [menuTxn, setMenuTxn] = useState<{
    t: Transaction;
    x: number;
    y: number;
  } | null>(null);
  const [toast, setToast] = useAccountsToast(linkedParam);
  // Header edit-pencil target (syscd-app-8uy) — reuses the rail's modal.
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  // ?account=<id>&edit=1 — open the editor once for the deep-linked account
  // (the Add-Account bank path): create → editor → bank section links 1:1.
  useEffect(() => {
    if (editParam === '1' && accountParam) setEditingAccount(accountParam);
  }, [editParam, accountParam]);

  const { personOf } = usePeople(budgetId);
  // The owner-face slot exists only in All Accounts and only when some account
  // has a person: a household that doesn't use people sees the register as before.
  const showOwnerSlot = !selectedAccountId && !!budget?.accounts.some((a) => a.userId);
  const selectedAccount = budget?.accounts.find(
    (a) => a.id === selectedAccountId,
  );

  const reconcile = useReconcileSession({
    budgetId,
    selectedAccount,
    selectedAccountId,
    isPhone: shell.isPhone,
    screenRef,
    onToast: setToast,
  });
  const { reconciling } = reconcile;

  const selection = useRegisterSelection({
    budget,
    budgetId,
    selectedAccountId,
    transactions,
    registerTxns,
    shortcutsBlocked: !!(editingTxnId || menuTxn || reconciling),
    setEditingTxnId,
  });
  const { selectedTxns } = selection;

  const { showRunningBalance } = filter;
  const runningBalances = useMemo(
    () => registerRunningBalances(showRunningBalance, selectedAccount, transactions, todayIso()),
    [showRunningBalance, selectedAccount, transactions],
  );

  if (!budget || !budgetId) {
    return (
      <View style={styles.center}>
        {error ? (
          <Text style={{ color: colors.redFg }}>{error}</Text>
        ) : (
          <ActivityIndicator color={colors.indigo2} />
        )}
      </View>
    );
  }

  // Edit-pencil modal target (raw rows for the milli-balance editor).
  const editAccountRow =
    accountRows?.find((a) => a.id === editingAccount) ?? null;
  const totals = scopeBalances(selectedAccount ? [selectedAccount] : budget.accounts);
  const unapprovedCount = filter.unapprovedTxns.length;
  const showWide = shell.isDesktop;

  // Cleared/uncleared flip from the row badge (task 3): the balance buckets
  // move with the flip; the server derives the balance deltas from the row.
  const toggleCleared = (t: Transaction) => {
    const next =
      t.cleared === "cleared" ? ("uncleared" as const) : ("cleared" as const);
    void updateTransaction({
      budgetId,
      id: t.id,
      patch: { cleared: next },
    });
  };
  const approveTxn = (t: Transaction) =>
    void updateTransaction({ budgetId, id: t.id, patch: { approved: true } });
  const openRowMenu = (t: Transaction, pageX: number, pageY: number) =>
    anchorAt(pageX, pageY, (x, y) => setMenuTxn({ t, x, y }));

  return (
    <View
      ref={screenRef}
      style={[
        styles.screen,
        !shell.isDesktop && { paddingTop: shell.contentTopPad },
      ]}
    >
      <View style={[styles.body, shell.isPhone && styles.bodyPhone]}>
        <View style={styles.main}>
          {unapprovedCount > 0 && !filter.bannerDismissed ? (
            <ApprovalBanner
              count={unapprovedCount}
              active={filter.showUnapprovedOnly}
              onView={filter.toggleUnapprovedOnly}
              onDismiss={filter.dismissBanner}
            />
          ) : null}

          <AccountHeader
            isPhone={shell.isPhone}
            selectedAccount={selectedAccount}
            owner={selectedAccount ? personOf(selectedAccount.userId) : null}
            reconciling={reconciling}
            topbarRef={reconcile.topbarRef}
            reconcileBtnRef={reconcile.reconcileBtnRef}
            onEditAccount={setEditingAccount}
            onReconcile={reconcile.openReconcilePopover}
            onImport={shell.openImportTransactions}
            showReconciled={filter.showReconciled}
            onToggleReconciled={filter.setShowReconciled}
            totals={totals}
            futureInstallments={selectedAccount ? futureInstallmentsTotal(transactions) : 0}
            unapprovedCount={unapprovedCount}
            showUnapprovedOnly={filter.showUnapprovedOnly}
            onToggleUnapprovedOnly={filter.toggleUnapprovedOnly}
          />

          <AccountsToolbar
            phone={shell.isPhone}
            showAdd={!shell.isPhone}
            density={filter.density}
            onDensityChange={filter.setDensity}
            showReconciled={filter.showReconciled}
            onShowReconciledChange={filter.setShowReconciled}
            showRunningBalance={showRunningBalance}
            onShowRunningBalanceChange={filter.setShowRunningBalance}
            showClosedTxns={filter.showClosedTxns}
            onShowClosedTxnsChange={filter.setShowClosedTxns}
            dateFrom={filter.dateFrom}
            onDateFromChange={filter.setDateFrom}
            dateTo={filter.dateTo}
            onDateToChange={filter.setDateTo}
            searchQuery={filter.searchQuery}
            onSearchChange={filter.changeSearch}
            onAddTransaction={() =>
              showWide ? setInlineAddOpen(true) : shell.openAddTransaction()
            }
            onImport={shell.openImportTransactions}
            sync={syncStatus}
          />

          {selectedAccount && reconciling ? (
            <ReconcileBanner
              statedBalance={reconcile.statedBalance}
              onStatedBalanceChange={reconcile.setStatedBalance}
              diff={reconcile.reconcileDiff}
              error={reconcile.reconcileError}
              onCancel={reconcile.cancelReconcile}
              onConfirm={() => void reconcile.confirmReconcile()}
            />
          ) : null}

          {/* register header */}
          {showWide ? (
            <RegisterHeader
              allSelected={selection.allRegisterSelected}
              onToggleAll={selection.toggleSelectAllVisible}
              showOwnerSlot={showOwnerSlot}
              showRunningBalance={showRunningBalance}
            />
          ) : null}

          {showWide && inlineAddOpen ? (
            <InlineAddRow
              budget={budget}
              budgetId={budgetId}
              defaultAccountId={selectedAccountId}
              onClose={() => setInlineAddOpen(false)}
            />
          ) : null}

          <RegisterList
            budget={budget}
            budgetId={budgetId}
            rows={registerTxns}
            scheduled={scheduledTxns}
            isPhone={shell.isPhone}
            showWide={showWide}
            density={filter.density}
            selectedAccountId={selectedAccountId}
            editingTxnId={editingTxnId}
            onEditingChange={setEditingTxnId}
            onEditPhone={shell.openEditTransaction}
            selectedIds={selection.selectedIds}
            showOwnerSlot={showOwnerSlot}
            personOf={personOf}
            showRunningBalance={showRunningBalance}
            runningBalances={runningBalances}
            onPressRow={selection.pressRegisterRow}
            onToggleSelected={selection.toggleRow}
            onApprove={approveTxn}
            onToggleCleared={toggleCleared}
            onOpenMenu={openRowMenu}
          />
          {selectedTxns.length > 0 ? (
            <SelectionBar
              count={selectedTxns.length}
              categories={filter.categories}
              groups={budget.groups}
              onCategorize={(categoryId) =>
                selection.patchSelected({ categoryId, approved: true })
              }
              onFlag={(flag) => selection.patchSelected({ flag, approved: true })}
              onCleared={(cleared) => selection.clearSelected(cleared)}
              allCleared={selection.allCleared}
              canMatch={selection.canMatch}
              hasMatched={selection.hasMatched}
              onMatch={selection.matchSelected}
              onUnmatch={selection.unmatchSelected}
              onDuplicate={selection.duplicateSelected}
              onMemo={selection.memoSelected}
              onExport={selection.exportSelected}
              onDelete={selection.deleteSelected}
              moveTargets={selection.moveTargets}
              onMoveTo={selection.moveToSelected}
              onClose={selection.clearSelection}
            />
          ) : null}
        </View>
      </View>
      {menuTxn && budget && process.env.EXPO_OS === "web" ? (
        <TxnRowMenu
          anchor={{ x: menuTxn.x, y: menuTxn.y }}
          txn={menuTxn.t}
          budget={budget}
          budgetId={budgetId}
          onEditMemo={(mt) => {
            setMenuTxn(null);
            setEditingTxnId(mt.id);
          }}
          onClose={() => setMenuTxn(null)}
        />
      ) : null}
      <ReconcilePopover
        anchor={reconcile.reconcileAnchor}
        workingBalance={selectedAccount ? workingBalance(selectedAccount) : null}
        onDismiss={reconcile.closeReconcilePopover}
        onNo={reconcile.confirmReconcileQuestion}
        onYes={() => void reconcile.reconcileAllNow()}
      />
      {/* edit pencil target (syscd-app-8uy) — the rail's account modal */}
      {editingAccount && editAccountRow ? (
        <AccountEditModal
          account={editAccountRow}
          budgetId={budgetId}
          onClose={() => setEditingAccount(null)}
        />
      ) : null}
      {/* reconcile success toast (syscd-app-qfr) */}
      {toast ? (
        <View
          style={styles.toast}
          pointerEvents="none"
          accessibilityLiveRegion="polite"
        >
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  body: { flex: 1, minHeight: 0 },
  bodyPhone: {},
  main: { flex: 1, minWidth: 0 },
  toast: {
    position: "absolute",
    bottom: 18,
    alignSelf: "center",
    zIndex: 40,
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  toastText: { color: colors.text, fontSize: 13, fontWeight: "600" },
});
