/**
 * Accounts — account list with cleared/uncleared/working balances (Cash /
 * Credit / Closed), the virtualized transaction register (columns, category
 * pill, cleared indicator, approve queue) and the YNAB-parity reconcile flow
 * (header entry → confirm popover → live-difference banner → adjustment, with
 * reconciled rows locked and hidden by default).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewInstance,
} from "react-native";

import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";

import { apiErrorMessage } from "@/platform/api/baseQuery";

import {
  useAddTransactionMutation,
  useUpdateTransactionMutation,
  useDeleteTransactionMutation,
  useReconcileAccountMutation,
  useGetAccountsQuery,
  useGetConnectionsQuery,
} from "../data/api";
import { connectionStatusView, formatSyncStamp } from "../model/banks/connections";
import { AccountEditModal } from "./AccountEditModal";
import { computeRunningBalances, workingBalance } from "../domain/engine";
import { todayIso } from "../domain/format";
import { useMoneyFormat } from '../model/useDisplayPrefs';
import type { Budget, Cents, Transaction } from "../domain/types";
import { registerCategoryCell } from "../domain/register";
import type { TransactionInput } from "../data/mapping";
import { GhostButton, IndigoButton, MoneyInput } from "../ui/bits";
import { colors, radius } from "../ui/theme";
import { AccountOwnerFace, BelongsTo } from "../ui/PersonFace";
import { usePeople } from "../model/usePeople";
import { useBudgetModel } from "../model/useBudgetModel";
import { useBudgetShell } from "./shell";
import { ApprovalBanner } from "./accounts/ApprovalBanner";
import { BalanceFormulaRow } from "./accounts/BalanceFormulaRow";
import {
  AccountsToolbar,
  type RegisterDensity,
} from "./accounts/AccountsToolbar";
import { AccountsMoreMenu } from "./accounts/AccountsMoreMenu";
import { ScheduledSection } from "./accounts/ScheduledSection";
import { SelectionBar, SelectionCheckbox } from "./accounts/SelectionBar";
import { ClearedBadge } from "./register/ClearedBadge";
import { InlineAddRow } from "./register/InlineAddRow";
import {
  txnsCsv,
  downloadCsv,
  matchCandidates,
} from "./register/txnRowMenuShared";
import { TxnRowMenu } from "./register/TxnRowMenu";
import { TxnMenuKebab } from "./register/TxnMenuKebab";
import { TxnMenuTrigger } from "./register/TxnMenuTrigger";

// Header subtitle (syscd-app-8uy): '<type label> · reconciled status'.
const ACCOUNT_TYPE_LABEL: Record<Budget["accounts"][number]["type"], string> = {
  checking: "Checking",
  savings: "Savings",
  cash: "Cash",
  credit: "Credit Card",
  tracking: "Tracking Account",
};
/** Stable empty array so `visibleTxns` deps stay referentially equal while loading. */
const EMPTY_CATEGORIES: Budget["categories"] = [];

export function AccountsScreen() {
  const { formatDate, formatMoney, parseMoney } = useMoneyFormat();
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
  const [reconciling, setReconciling] = useState(false);
  const [statedBalance, setStatedBalance] = useState(0);
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
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconcileAccount, reconcileState] = useReconcileAccountMutation();
  const [updateTransaction] = useUpdateTransactionMutation();
  const [addTransaction] = useAddTransactionMutation();
  const [deleteTransaction] = useDeleteTransactionMutation();

  // Raw account rows (milli balances) — feeds the edit-account modal, which
  // works on server rows, not the domain model.
  const accountRows = useGetAccountsQuery(
    budgetId ? { budgetId } : { budgetId: "" },
    { skip: !budgetId },
  );
  // Sync status for the toolbar chip: the selected account's connection.
  const connectionsQuery = useGetConnectionsQuery(undefined, { skip: !budgetId });

  // Closed-account transactions are hidden in All Accounts unless shown
  // (closed accounts are immutable; YNAB parity).
  const [showClosedTxns, setShowClosedTxns] = useState(false);

  const transactions = useMemo(() => {
    if (!budget) return [];
    // All Accounts hides closed-account rows unless the View toggle is on;
    // an explicit account selection always shows its full register.
    const txns = selectedAccountId
      ? budget.transactions.filter((t) => t.accountId === selectedAccountId)
      : budget.transactions.filter((t) => {
          const group = budget.accounts.find(
            (a) => a.id === t.accountId,
          )?.group;
          return showClosedTxns || group !== "CLOSED";
        });
    return [...txns].sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
    );
  }, [budget, selectedAccountId, showClosedTxns]);

  // Unapproved count in the unfiltered scope (account selection applies) —
  // drives the banner and its View filter, independent of the search query.
  const unapprovedTxns = useMemo(
    () => transactions.filter((t) => !t.approved),
    [transactions],
  );

  // Hooks must precede the loading guard below (rules of hooks).
  const [inlineAddOpen, setInlineAddOpen] = useState(false);
  const [editingTxnId, setEditingTxnId] = useState<string | null>(null);
  // Row context menu (syscd-app-42f): kebab click / right-click opens the
  // YNAB transaction menu for that row.
  const [menuTxn, setMenuTxn] = useState<{
    t: Transaction;
    x: number;
    y: number;
  } | null>(null);
  // Header state — approval-banner filter (View all / View), row density and
  // the register search query. Undo/Redo: syscd-app-ijn.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [showUnapprovedOnly, setShowUnapprovedOnly] = useState(false);
  const [density, setDensity] = useState<RegisterDensity>("comfortable");
  const [searchQuery, setSearchQuery] = useState("");
  // YNAB view options: reconciled rows are hidden unless shown; running
  // balance column off by default; date range filters the register
  // (syscd-app-ojj).
  const [showReconciled, setShowReconciled] = useState(false);
  const [showRunningBalance, setShowRunningBalance] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Reconcile session (syscd-app-mbi): the confirm popover anchor in
  // screen-root space, then a live-difference banner. "No" on the question
  // closes the popover and does nothing — no statement-entry path.
  const [reconcileAnchor, setReconcileAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // Success toast (syscd-app-qfr): "Account reconciled", auto-hides.
  const [toast, setToast] = useState<string | null>(null);
  // Header edit-pencil target (syscd-app-8uy) — reuses the rail's modal.
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  // ?account=<id>&edit=1 — open the editor once for the deep-linked account
  // (the Add-Account bank path): create → editor → bank section links 1:1.
  useEffect(() => {
    if (editParam === '1' && accountParam) setEditingAccount(accountParam);
  }, [editParam, accountParam]);
  // Reconcile button wrapper — the confirm popover anchors under it.
  const reconcileBtnRef = useRef<ViewInstance>(null);
  // tk-lj5l: phone popover anchor — the header row itself, since the phone
  // Reconcile entry lives in the ⋯ menu rather than a measurable button.
  const topbarRef = useRef<ViewInstance>(null);

  // Multi-select for the register's selection action bar (Images #7/#8/#9).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Shift-click range anchor (web, YNAB register): the last row the user
  // clicked or toggled; the next shift-click selects everything between.
  const [selAnchorId, setSelAnchorId] = useState<string | null>(null);
  // Scope switch (rail account change) invalidates stale ids.
  useEffect(() => {
    setSelectedIds(new Set());
    setSelAnchorId(null);
    // Switching accounts mid-session would strand the banner on the wrong
    // account — close the session and popover too.
    setReconciling(false);
    setReconcileAnchor(null);
  }, [selectedAccountId]);

  // Toast auto-hide (syscd-app-qfr).
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  // The connect flow lands here with ?linked=N — show its outcome count once.
  const linkedCount = linkedParam ? Number(linkedParam) : 0;
  useEffect(() => {
    if (linkedCount > 0) {
      setToast(`Linked ${linkedCount} account${linkedCount === 1 ? '' : 's'}`);
    }
    // Only on mount/param change — the toast state owns dismissal.
  }, [linkedCount]);

  // Derived scope + register memos must run before any early return
  // (react-hooks/rules-of-hooks): `budget` is optional-chained and an empty
  // category fallback keeps the memos valid while the budget query loads.
  const { personOf } = usePeople(budgetId);
  // The owner-face slot exists only in All Accounts and only when some account
  // has a person: a household that doesn't use people sees the register as before.
  const showOwnerSlot = !selectedAccountId && !!budget?.accounts.some((a) => a.userId);
  const selectedAccount = budget?.accounts.find(
    (a) => a.id === selectedAccountId,
  );
  // Toolbar sync chip: the selected account's bank link, resolved from the
  // server rows — the domain model drops the link columns.
  const linkedRow = accountRows.data?.find((a) => a.id === selectedAccountId);
  const linkedConnection =
    linkedRow?.connection_id != null
      ? connectionsQuery.data?.find((c) => c.id === linkedRow.connection_id)
      : undefined;
  const syncStatus =
    linkedRow && linkedConnection
      ? {
          bank:
            linkedRow.institution ??
            linkedConnection.institution ??
            linkedConnection.provider,
          ...connectionStatusView(linkedConnection.status),
          stamp: linkedConnection.last_synced_at
            ? formatSyncStamp(linkedConnection.last_synced_at)
            : null,
        }
      : undefined;
  const categories = budget?.categories ?? EMPTY_CATEGORIES;

  const selectedTxns = useMemo(
    () => transactions.filter((t) => selectedIds.has(t.id)),
    [transactions, selectedIds],
  );
  // More-menu enablement (Image #2): Match needs exactly one selectable
  // candidate pair — the row-menu flow stays the multi-candidate picker;
  // Unmatch needs a matched row in the selection.
  const canMatch = useMemo(() => {
    if (!budget || selectedTxns.length !== 2) return false;
    const [a, b] = selectedTxns;
    if (a.matchedTransactionId || b.matchedTransactionId) return false;
    return matchCandidates(a, budget).some((c) => c.id === b.id);
  }, [selectedTxns, budget]);
  const hasMatched = selectedTxns.some((t) => t.matchedTransactionId);
  /** Mark-as label direction: all-cleared selection flips to "Mark as Uncleared". */
  const allCleared =
    selectedTxns.length > 0 &&
    selectedTxns.every((t) => t.cleared !== "uncleared");

  // Register rows: banner "View" filter (unapproved only) composed with the
  // toolbar search — payee / category / memo substrings, plus an exact amount
  // match when the query parses as money (pt-BR, via parseMoney).
  const visibleTxns = useMemo(() => {
    let rows = transactions;
    // Reconciled rows stay hidden unless View Options opts in (syscd-app-lqu);
    // this is also what drops them right after a successful reconcile
    // (syscd-app-qfr).
    if (!showReconciled) rows = rows.filter((t) => t.cleared !== "reconciled");
    if (showUnapprovedOnly) rows = rows.filter((t) => !t.approved);
    if (dateFrom) rows = rows.filter((t) => t.date >= dateFrom);
    if (dateTo) rows = rows.filter((t) => t.date <= dateTo);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    const qCents = parseMoney(searchQuery);
    return rows.filter((t) => {
      const cat = categories.find((c) => c.id === t.categoryId);
      if (qCents !== 0 && (t.inflow === qCents || t.outflow === qCents))
        return true;
      return (
        (t.payee ?? "").toLowerCase().includes(q) ||
        (cat?.name ?? "").toLowerCase().includes(q) ||
        (t.memo ?? "").toLowerCase().includes(q)
      );
    });
  }, [
    transactions,
    categories,
    showReconciled,
    showUnapprovedOnly,
    dateFrom,
    dateTo,
    searchQuery,
    parseMoney,
  ]);

  // Future-dated rows leave the register and render in the "Scheduled
  // Transactions" footer section (syscd-app-5nz); the rest stay in the list.
  const registerTxns = useMemo(() => {
    const today = todayIso();
    return visibleTxns.filter((t) => t.date <= today);
  }, [visibleTxns]);
  const scheduledTxns = useMemo(() => {
    const today = todayIso();
    return visibleTxns.filter((t) => t.date > today);
  }, [visibleTxns]);

  // Select-all (syscd-app-vnwz): the header checkbox covers every visible
  // register row — reconciled included. Checking unions into the selection;
  // unchecking removes only the visible rows, keeping any hidden selections.
  const allRegisterSelected =
    registerTxns.length > 0 && registerTxns.every((t) => selectedIds.has(t.id));
  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allRegisterSelected) {
        for (const t of registerTxns) next.delete(t.id);
      } else {
        for (const t of registerTxns) next.add(t.id);
      }
      return next;
    });
  };

  // Running balance (syscd-app-ojj, off by default): YNAB semantics — the
  // newest row's running balance equals the account's working balance and the
  // column walks backwards through the register. Computed over the account's
  // full register (not the filtered view) so search/option filters never
  // distort the numbers.
  const runningBalances = useMemo(() => {
    if (!showRunningBalance || !selectedAccount)
      return new Map<string, Cents>();
    const today = todayIso();
    return computeRunningBalances(
      transactions.filter((t) => t.date <= today),
      workingBalance(selectedAccount),
    );
  }, [showRunningBalance, selectedAccount, transactions]);

  // Selection patches (categorize/flag/clear/memo) — one mutation per row.
  const patchSelected = useCallback(
    (patch: Partial<TransactionInput>, after?: () => void) => {
      if (!budgetId) return;
      for (const t of selectedTxns) {
        void updateTransaction({ budgetId, id: t.id, patch });
      }
      setSelectedIds(new Set());
      after?.();
    },
    [budgetId, selectedTxns, updateTransaction],
  );

  // Clear does NOT approve — approving repaints the row (indigoSoft =
  // unapproved) and clearing must not change the line color.
  const clearSelected = useCallback(
    (cleared?: "cleared" | "uncleared" | "reconciled") => {
      patchSelected({
        cleared: cleared ?? (allCleared ? "uncleared" : "cleared"),
      });
    },
    [allCleared, patchSelected],
  );

  const matchSelected = useCallback(() => {
    if (!budgetId || !canMatch) return;
    const [a, b] = selectedTxns;
    void updateTransaction({
      budgetId,
      id: a.id,
      patch: { matchedTransactionId: b.id },
    });
    void updateTransaction({
      budgetId,
      id: b.id,
      patch: { matchedTransactionId: a.id },
    });
    setSelectedIds(new Set());
  }, [budgetId, canMatch, selectedTxns, updateTransaction]);

  const unmatchSelected = useCallback(() => {
    if (!budgetId) return;
    for (const t of selectedTxns) {
      const other = t.matchedTransactionId;
      if (!other) continue;
      void updateTransaction({
        budgetId,
        id: t.id,
        patch: { matchedTransactionId: null },
      });
      if (!selectedIds.has(other)) {
        void updateTransaction({
          budgetId,
          id: other,
          patch: { matchedTransactionId: null },
        });
      }
    }
    setSelectedIds(new Set());
  }, [budgetId, selectedTxns, selectedIds, updateTransaction]);

  const duplicateSelected = useCallback(() => {
    if (!budgetId) return;
    for (const t of selectedTxns) {
      void addTransaction({
        budgetId,
        txn: {
          accountId: t.accountId,
          date: t.date,
          payee: t.payee,
          categoryId: t.categoryId,
          memo: t.memo ?? "",
          outflowCents: t.outflow,
          inflowCents: t.inflow,
          cleared: t.cleared,
          approved: t.approved,
          flag: t.flag ?? null,
          repeat: t.repeat,
        },
      });
    }
    setSelectedIds(new Set());
  }, [budgetId, selectedTxns, addTransaction]);

  const memoSelected = () => {
    if (process.env.EXPO_OS === "web") {
      const memo = window.prompt(
        "Memo",
        selectedTxns.length === 1 ? (selectedTxns[0].memo ?? "") : "",
      );
      if (memo === null) return;
      patchSelected({ memo });
      return;
    }
    // Native: fall back to the row's inline editor on the first selected row.
    setEditingTxnId(selectedTxns[0]?.id ?? null);
    setSelectedIds(new Set());
  };

  const exportSelected = () => {
    if (!budget) return;
    if (process.env.EXPO_OS === "web") {
      downloadCsv(
        `transactions-${todayIso()}.csv`,
        txnsCsv(selectedTxns, budget),
      );
    }
  };

  const deleteSelected = useCallback(() => {
    if (!budgetId) return;
    if (
      process.env.EXPO_OS === "web" &&
      !window.confirm(`Delete ${selectedTxns.length} transaction(s)?`)
    )
      return;
    for (const t of selectedTxns) {
      void deleteTransaction({ budgetId, id: t.id });
    }
    setSelectedIds(new Set());
  }, [budgetId, selectedTxns, deleteTransaction]);

  // Selection shortcuts (web, Image #2 keycaps): C marks cleared/uncleared,
  // M matches, shift+U unmatches, shift+D duplicates, delete/backspace
  // deletes. Claimed only while a selection exists and no editor, row menu,
  // or reconcile popover owns the interaction; text fields skip so inline
  // typing is untouched.
  useEffect(() => {
    if (process.env.EXPO_OS !== "web") return undefined;
    if (selectedTxns.length === 0) return undefined;
    if (editingTxnId || menuTxn || reconciling) return undefined;
    const el = document.activeElement;
    if (
      el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        (el as HTMLElement).isContentEditable)
    )
      return undefined;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "c" || ev.key === "C") {
        ev.preventDefault();
        clearSelected(allCleared ? "uncleared" : "cleared");
      } else if (ev.shiftKey && (ev.key === "u" || ev.key === "U")) {
        if (!hasMatched) return;
        unmatchSelected();
      } else if (ev.shiftKey && (ev.key === "d" || ev.key === "D")) {
        duplicateSelected();
      } else if (!ev.shiftKey && (ev.key === "m" || ev.key === "M")) {
        if (!canMatch) return;
        matchSelected();
      } else if (ev.key === "Delete" || ev.key === "Backspace") {
        deleteSelected();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [
    selectedTxns,
    canMatch,
    hasMatched,
    allCleared,
    editingTxnId,
    menuTxn,
    reconciling,
    clearSelected,
    matchSelected,
    unmatchSelected,
    duplicateSelected,
    deleteSelected,
  ]);

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
    accountRows.data?.find((a) => a.id === editingAccount) ?? null;
  const inScope = selectedAccount ? [selectedAccount] : budget.accounts;
  const clearedTotal = inScope.reduce((s, a) => s + a.clearedBalance, 0);
  const unclearedTotal = inScope.reduce((s, a) => s + a.unclearedBalance, 0);
  const working = inScope.reduce((s, a) => s + workingBalance(a), 0);
  const unapprovedCount = unapprovedTxns.length;
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

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startReconcile = (anchor: { x: number; y: number }) => {
    if (!selectedAccount) return;
    setStatedBalance(workingBalance(selectedAccount));
    setReconcileAnchor(anchor);
  };

  // Popover anchor derived from the header button's own geometry — no press
  // event needed, so it works identically at desktop and phone widths. The
  // button is right-aligned, so clamp x to keep the popover on screen.
  const openReconcilePopover = () => {
    // tk-lj5l: on phone the standalone Reconcile button is gone (the action
    // lives in the header ⋯ menu), so there is no button geometry to anchor
    // to — right-align the popover under the header instead.
    if (shell.isPhone) {
      // tk-lj5l: no standalone button on phone, so anchor the popover under
      // the header row itself (right-aligned, same clamp as desktop).
      topbarRef.current?.measureInWindow((_tx, ty, _tw, th) => {
        screenRef.current?.measureInWindow((_sx, sy, sw) => {
          const belowTopbar = ty - sy + th + 6;
          startReconcile({
            x: sw ? Math.max(0, sw - 268) : 0,
            y: th > 0 ? belowTopbar : 96,
          });
        });
      });
      return;
    }
    reconcileBtnRef.current?.measureInWindow((bx, by, bw, bh) => {
      screenRef.current?.measureInWindow((sx, sy, sw) => {
        const rawX = bx - sx + bw - 16;
        startReconcile({
          x: sw ? Math.max(0, Math.min(rawX, sw - 268)) : rawX,
          y: by - sy + bh + 6,
        });
      });
    });
  };

  // Question answers (syscd-app-mbi, YNAB semantics). "No" opens the
  // statement-entry session — the user enters the bank balance and YNAB
  // computes the difference. "Yes" means the on-screen balance already
  // matches the bank, so everything reconciles instantly: no session, no
  // adjustment, nothing for the user to do.
  const confirmReconcileQuestion = () => {
    setReconcileAnchor(null);
    setReconciling(true);
  };

  const reconcileAllNow = async () => {
    if (!selectedAccount || reconcileState.isLoading) return;
    setReconcileAnchor(null);
    setReconcileError(null);
    try {
      await reconcileAccount({
        budgetId,
        accountId: selectedAccount.id,
        statedBalanceCents: workingBalance(selectedAccount),
        reconcileAll: true,
      }).unwrap();
      setToast("Account reconciled");
    } catch (err) {
      // Auto-reconcile failed (network/server): drop into the manual session
      // so the user can finish it by hand instead of a dead-end error.
      setReconciling(true);
      setStatedBalance(workingBalance(selectedAccount));
      setReconcileError(apiErrorMessage(err, "failed to reconcile account"));
    }
  };

  // Live difference for the session banner, in cents. 0 means a plain lock-in.
  // YNAB semantics: the difference is the stated balance vs the WORKING
  // balance (cleared + uncleared); reconciling locks every row. Finishing at 0 books no adjustment;
  // the server (PATCH /accounts/:id/reconcile) compares the same values.
  const reconcileDiff =
    reconciling && selectedAccount
      ? statedBalance - workingBalance(selectedAccount)
      : 0;

  const moveTargets = budget.accounts
    .filter(
      (a) =>
        a.group !== "CLOSED" && selectedTxns.every((t) => t.accountId !== a.id),
    )
    .map((a) => ({ id: a.id, name: a.name, disabled: false }));
  const moveToSelected = (accountId: string) => {
    for (const t of selectedTxns) {
      if (t.accountId === accountId) continue;
      void updateTransaction({
        budgetId,
        id: t.id,
        patch: { accountId },
      });
    }
    setSelectedIds(new Set());
  };

  // Register row press (web, YNAB register): plain click opens the inline
  // editor; ctrl/cmd-click toggles the row's selection; shift-click selects
  // the whole range from the last-clicked anchor. Modifier keys exist only
  // on web pointer events — RN's responder event doesn't type them.
  const pressRegisterRow = (t: Transaction, e: GestureResponderEvent) => {
    const mod = e as unknown as {
      ctrlKey?: boolean;
      metaKey?: boolean;
      shiftKey?: boolean;
    };
    if (
      process.env.EXPO_OS !== "web" ||
      (!mod.ctrlKey && !mod.metaKey && !mod.shiftKey)
    ) {
      // Plain click opens the inline editor — reconciled rows are locked
      // (syscd-app-lqu) and stay non-editable; selection is always allowed.
      if (t.cleared === "reconciled") return;
      setEditingTxnId(t.id);
      return;
    }
    setEditingTxnId(null);
    const idx = registerTxns.findIndex((r) => r.id === t.id);
    if (mod.shiftKey) {
      const anchorIdx = selAnchorId
        ? registerTxns.findIndex((r) => r.id === selAnchorId)
        : 0;
      const lo = Math.min(idx, Math.max(anchorIdx, 0));
      const hi = Math.max(idx, Math.max(anchorIdx, 0));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i += 1) {
          const row = registerTxns[i];
          if (row) next.add(row.id);
        }
        return next;
      });
      setSelAnchorId(t.id);
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(t.id)) next.delete(t.id);
      else next.add(t.id);
      return next;
    });
    setSelAnchorId(t.id);
  };

  const confirmReconcile = async () => {
    if (!selectedAccount || reconcileState.isLoading) return;
    setReconcileError(null);
    try {
      await reconcileAccount({
        budgetId,
        accountId: selectedAccount.id,
        statedBalanceCents: statedBalance,
      }).unwrap();
      setReconciling(false);
      // syscd-app-qfr: success toast; reconciled rows vanish because the
      // showReconciled view option defaults to false.
      setToast("Account reconciled");
    } catch (err) {
      setReconcileError(apiErrorMessage(err, "failed to reconcile account"));
    }
  };

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
          {unapprovedCount > 0 && !bannerDismissed ? (
            <ApprovalBanner
              count={unapprovedCount}
              active={showUnapprovedOnly}
              onView={() => setShowUnapprovedOnly(!showUnapprovedOnly)}
              onDismiss={() => {
                setBannerDismissed(true);
                setShowUnapprovedOnly(false);
              }}
            />
          ) : null}

          <View style={styles.topbar}>
            <View ref={topbarRef} collapsable={false} style={styles.topbarRow}>
              <View style={styles.topbarLeft}>
                <View style={styles.titleRow}>
                  <Text
                    style={[styles.title, shell.isPhone && styles.titlePhone]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {selectedAccount ? selectedAccount.name : "All Accounts"}
                  </Text>
                  {selectedAccount ? (
                    <Pressable
                      hitSlop={6}
                      style={styles.iconBtn}
                      onPress={() => setEditingAccount(selectedAccount.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Edit account ${selectedAccount.name}`}
                    >
                      <Ionicons name="pencil" size={14} color={colors.faint} />
                    </Pressable>
                  ) : null}
                  {/* tk-lj5l (spec item 9): on phone the header row is title +
                    trailing ⋯ — every overflow action (File Import, Reconcile,
                    Show Reconciled, Edit/Link Account) lives in the native
                    AccountsMoreMenu; the title truncates so it never pushes
                    the menu. Desktop keeps its own actions below. Web-phone
                    additionally surfaces Reconcile as a visible button beside
                    the ⋯ (user ask); on iOS both the button and the row-style
                    override gate off `EXPO_OS === "web"`, so the native tree
                    is unchanged. */}
                  {shell.isPhone ? (
                    <View
                      style={[
                        styles.topbarTrail,
                        process.env.EXPO_OS === "web" &&
                          styles.topbarTrailWeb,
                      ]}
                    >
                      {process.env.EXPO_OS === "web" &&
                      selectedAccount &&
                      !reconciling ? (
                        <IndigoButton
                          label="Reconcile"
                          onPress={openReconcilePopover}
                        />
                      ) : null}
                      <AccountsMoreMenu
                        onImport={shell.openImportTransactions}
                        onReconcile={
                          selectedAccount && !reconciling
                            ? openReconcilePopover
                            : undefined
                        }
                        showReconciled={showReconciled}
                        onToggleReconciled={setShowReconciled}
                        onEditAccount={
                          selectedAccount && !reconciling
                            ? () => setEditingAccount(selectedAccount.id)
                            : undefined
                        }
                      />
                    </View>
                  ) : null}
                </View>
                {selectedAccount ? (
                  <Text
                    style={styles.subtitle}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {ACCOUNT_TYPE_LABEL[selectedAccount.type]} ·{" "}
                    {selectedAccount.lastReconciledAt
                      ? `Last reconciled ${formatDate(selectedAccount.lastReconciledAt.slice(0, 10))}`
                      : "🔒 Not Yet Reconciled"}
                  </Text>
                ) : null}
                {selectedAccount ? (
                  <BelongsTo
                    person={personOf(selectedAccount.userId)}
                    onPress={() => setEditingAccount(selectedAccount.id)}
                  />
                ) : null}
              </View>
              {/* Reconcile entry (syscd-app-8uy) — moved out of the View menu;
                hidden while the session banner is up. Trailing-aligned in the
                header row at desktop/tablet; phone reaches it through the ⋯
                menu (tk-lj5l). */}
              {!shell.isPhone && selectedAccount && !reconciling ? (
                <View
                  ref={reconcileBtnRef}
                  collapsable={false}
                  style={styles.reconcileBtnWrap}
                >
                  <IndigoButton
                    label="Reconcile"
                    onPress={openReconcilePopover}
                  />
                </View>
              ) : null}
            </View>
            {shell.isPhone ? (
              <>
                <BalanceFormulaRow
                  hero
                  compact
                  cleared={clearedTotal}
                  uncleared={unclearedTotal}
                  working={working}
                />
                {/* tk-lj5l (item 7): count row directly under the hero — same
                  approval-queue filter as the banner's View action, no new
                  state. Active state mirrors the banner's filter. */}
                {unapprovedCount > 0 ? (
                  <Pressable
                    style={[
                      styles.unclearedRow,
                      showUnapprovedOnly && styles.unclearedRowOn,
                    ]}
                    onPress={() => setShowUnapprovedOnly(!showUnapprovedOnly)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: showUnapprovedOnly }}
                    accessibilityLabel={`${unapprovedCount} transactions to approve`}
                  >
                    <Text
                      style={[
                        styles.unclearedText,
                        showUnapprovedOnly && styles.unclearedTextOn,
                      ]}
                    >
                      {unapprovedCount} to approve
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : (
              <BalanceFormulaRow
                cleared={clearedTotal}
                uncleared={unclearedTotal}
                working={working}
              />
            )}
          </View>

          <AccountsToolbar
            phone={shell.isPhone}
            showAdd={!shell.isPhone}
            density={density}
            onDensityChange={setDensity}
            showReconciled={showReconciled}
            onShowReconciledChange={setShowReconciled}
            showRunningBalance={showRunningBalance}
            onShowRunningBalanceChange={setShowRunningBalance}
            showClosedTxns={showClosedTxns}
            onShowClosedTxnsChange={setShowClosedTxns}
            dateFrom={dateFrom}
            onDateFromChange={setDateFrom}
            dateTo={dateTo}
            onDateToChange={setDateTo}
            searchQuery={searchQuery}
            onSearchChange={(q) => {
              setSearchQuery(q);
              if (q) setShowUnapprovedOnly(false);
            }}
            onAddTransaction={() =>
              showWide ? setInlineAddOpen(true) : shell.openAddTransaction()
            }
            onImport={shell.openImportTransactions}
            sync={syncStatus}
          />

          {/* reconcile session banner (syscd-app-mbi): stated balance, live
            difference, and the YNAB actions — Finish reconciling when
            balanced, Reconcile anyway otherwise. */}
          {selectedAccount && reconciling ? (
            <View style={styles.banner}>
              <View style={styles.bannerMain}>
                <Text style={styles.kvLabel}>Bank balance</Text>
                <MoneyInput
                  cents={statedBalance}
                  onCommit={setStatedBalance}
                  autoFocus
                />
                <Text
                  style={[
                    styles.kvLabel,
                    reconcileDiff !== 0 && styles.bannerDiff,
                  ]}
                >
                  {reconcileDiff === 0
                    ? "✓ balanced"
                    : `Difference: ${formatMoney(reconcileDiff)}`}
                </Text>
                <View style={styles.bannerBtns}>
                  <GhostButton
                    label="Cancel"
                    onPress={() => setReconciling(false)}
                  />
                  <IndigoButton
                    label={
                      reconcileDiff === 0
                        ? "Finish reconciling"
                        : "Reconcile anyway"
                    }
                    onPress={() => void confirmReconcile()}
                  />
                </View>
              </View>
              {reconcileError ? (
                <Text style={styles.reconcileError} accessibilityRole="alert">
                  {reconcileError}
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* register header */}
          {showWide ? (
            <View style={styles.reghd}>
              {showWide ? (
                <SelectionCheckbox
                  checked={allRegisterSelected}
                  onToggle={toggleSelectAllVisible}
                  label="Select all transactions"
                />
              ) : null}
              <Text style={[styles.reghdText, { flex: 1.1 }, showOwnerSlot && { paddingLeft: 22 }]}>ACCOUNT</Text>
              <Text style={[styles.reghdText, { flex: 0.7 }]}>DATE</Text>
              <Text style={[styles.reghdText, { flex: 1.4 }]}>PAYEE</Text>
              <Text style={[styles.reghdText, { flex: 1.4 }]}>CATEGORY</Text>
              <Text style={[styles.reghdText, { flex: 1.2 }]}>MEMO</Text>
              <Text
                style={[styles.reghdText, { flex: 1.1, textAlign: "right" }]}
              >
                AMOUNT
              </Text>
              {showRunningBalance ? (
                <Text
                  style={[styles.reghdText, { width: 84, textAlign: "right" }]}
                >
                  RUN. BAL
                </Text>
              ) : null}
              <Text
                style={[styles.reghdText, { width: 30, textAlign: "center" }]}
              >
                C
              </Text>
              <Text style={[styles.reghdText, { width: 24 }]} />
            </View>
          ) : null}

          {showWide && inlineAddOpen ? (
            <InlineAddRow
              budget={budget}
              budgetId={budgetId}
              defaultAccountId={selectedAccountId}
              onClose={() => setInlineAddOpen(false)}
            />
          ) : null}

          <FlatList
            data={registerTxns}
            keyExtractor={(t) => t.id}
            // tk-lj5l (item 7): phone hosts Scheduled under the hero (list
            // header, above the register rows); desktop keeps the footer.
            ListHeaderComponent={
              shell.isPhone ? (
                <ScheduledSection
                  budget={budget}
                  budgetId={budgetId}
                  rows={scheduledTxns}
                  editingTxnId={editingTxnId}
                  showWide={showWide}
                  style={styles.scheduledPhone}
                  onEditWide={(t) => setEditingTxnId(t.id)}
                  onEditPhone={shell.openEditTransaction}
                  onCloseEdit={() => setEditingTxnId(null)}
                />
              ) : undefined
            }
            ListFooterComponent={
              shell.isPhone ? undefined : (
                <ScheduledSection
                  budget={budget}
                  budgetId={budgetId}
                  rows={scheduledTxns}
                  editingTxnId={editingTxnId}
                  showWide={showWide}
                  onEditWide={(t) => setEditingTxnId(t.id)}
                  onEditPhone={shell.openEditTransaction}
                  onCloseEdit={() => setEditingTxnId(null)}
                />
              )
            }
            renderItem={({ item: t }) => {
              const acct = budget.accounts.find((a) => a.id === t.accountId);
              const cat = registerCategoryCell(budget, t);
              if (!showWide) {
                return (
                  <TxnMenuTrigger
                    txn={t}
                    budget={budget}
                    budgetId={budgetId}
                    onEditMemo={() => shell.openEditTransaction(t)}
                  >
                    <Pressable
                      style={[
                        styles.txnCard,
                        density === "compact" && styles.txnCardCompact,
                      ]}
                      onPress={
                        t.cleared === "reconciled"
                          ? undefined
                          : () => shell.openEditTransaction(t)
                      }
                      accessibilityLabel={`Edit transaction ${t.payee || "(no payee)"}`}
                      accessibilityState={{
                        disabled: t.cleared === "reconciled",
                      }}
                    >
                      {/* Phone layout: two stacked lines so long payees
                          never crush the money pill (tk-boxi). Line 1 =
                          payee + Repeat + amount, line 2 = category +
                          account. Desktop (showWide) is untouched. */}
                      <View style={styles.txnL1Phone}>
                        <View style={styles.txnLeadPhone}>
                          <Text style={styles.txnPayee} numberOfLines={1}>
                            {t.payee || "(no payee)"}
                          </Text>
                          {t.upcoming ? (
                            <Text style={styles.upcomingPill}>Repeat</Text>
                          ) : null}
                        </View>
                        <View
                          style={[
                            styles.amtBox,
                            t.outflow > 0 ? styles.amtOut : styles.amtIn,
                          ]}
                        >
                          <Text
                            style={[
                              styles.amtGlyph,
                              t.outflow > 0
                                ? styles.amtOutGlyph
                                : styles.amtInGlyph,
                            ]}
                          >
                            {t.outflow > 0 ? "−" : "+"}
                          </Text>
                          <Text
                            style={[
                              styles.amtValue,
                              t.outflow > 0
                                ? styles.amtOutValue
                                : styles.amtInValue,
                            ]}
                            numberOfLines={1}
                          >
                            {formatMoney(t.outflow > 0 ? t.outflow : t.inflow)}
                          </Text>
                        </View>
                        <ClearedBadge
                          compact
                          status={t.cleared}
                          onApprove={
                            t.approved || t.cleared === "reconciled"
                              ? undefined
                              : () =>
                                  void updateTransaction({
                                    budgetId,
                                    id: t.id,
                                    patch: { approved: true },
                                  })
                          }
                          onToggle={
                            t.approved && t.cleared !== "reconciled"
                              ? () => toggleCleared(t)
                              : undefined
                          }
                        />
                        <TxnMenuKebab
                          onOpen={(px, py) =>
                            anchorAt(px, py, (x, y) =>
                              setMenuTxn({ t, x, y }),
                            )
                          }
                        />
                      </View>
                      <View style={styles.txnL2Phone}>
                        <Text
                          style={[
                            styles.tagPill,
                            cat.warn && styles.tagPillWarn,
                          ]}
                          numberOfLines={1}
                        >
                          {cat.text}
                        </Text>
                        {!selectedAccountId && acct ? (
                          <Text style={styles.txnAcct} numberOfLines={1}>
                            {acct.name}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  </TxnMenuTrigger>
                );
              }
              if (editingTxnId === t.id) {
                return (
                  <InlineAddRow
                    budget={budget}
                    budgetId={budgetId}
                    transaction={t}
                    onClose={() => setEditingTxnId(null)}
                  />
                );
              }
              return (
                <TxnMenuTrigger
                  txn={t}
                  budget={budget}
                  budgetId={budgetId}
                  onEditMemo={() => shell.openEditTransaction(t)}
                >
                  <Pressable
                    style={[
                      styles.regrow,
                      !t.approved && { backgroundColor: colors.indigoSoft },
                      t.upcoming && styles.regrowUpcoming,
                      density === "compact" && styles.regrowCompact,
                    ]}
                    onPress={(e) => pressRegisterRow(t, e)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      anchorAt(
                        e.nativeEvent.pageX,
                        e.nativeEvent.pageY,
                        (x, y) => setMenuTxn({ t, x, y }),
                      );
                    }}
                    accessibilityLabel={`Edit transaction ${t.payee || "(no payee)"}`}
                  >
                    <SelectionCheckbox
                      checked={selectedIds.has(t.id)}
                      onToggle={() => {
                        toggleSelected(t.id);
                        setSelAnchorId(t.id);
                      }}
                      label={`Select transaction ${t.payee || "(no payee)"}`}
                    />
                    <View style={[styles.regAcctCell, { flex: 1.1 }]}>
                      {/* Fixed 16px slot so account names align whether or not the
                          account has an owner (Shared shows no face). */}
                      {showOwnerSlot && acct ? (
                        <View style={styles.regAcctFace}>
                          <AccountOwnerFace person={personOf(acct.userId)} size={16} />
                        </View>
                      ) : null}
                      <Text
                        style={[styles.regText, { flexShrink: 1 }]}
                        numberOfLines={1}
                      >
                        {acct?.name}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.regText,
                        { flex: 0.7, color: colors.muted },
                      ]}
                    >
                      {formatDate(t.date)}
                    </Text>
                    <View
                      style={{
                        flex: 1.4,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <Text
                        style={[styles.regText, { flexShrink: 1 }]}
                        numberOfLines={1}
                      >
                        {t.payee || "(no payee)"}
                      </Text>
                      {t.upcoming ? (
                        <Text style={styles.upcomingPill}>Repeat</Text>
                      ) : null}
                    </View>
                    <View style={{ flex: 1.4, flexDirection: "row" }}>
                      <Text
                        style={[styles.tagPill, cat.warn && styles.tagPillWarn]}
                        numberOfLines={1}
                      >
                        {cat.text}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.regText,
                        { flex: 1.2, color: colors.faint },
                      ]}
                      numberOfLines={1}
                    >
                      {t.memo}
                    </Text>
                    <View
                      style={{
                        flex: 1.1,
                        flexDirection: "row",
                        justifyContent: "flex-end",
                      }}
                    >
                      <View
                        style={[
                          styles.amtBox,
                          t.outflow > 0 ? styles.amtOut : styles.amtIn,
                        ]}
                      >
                        <Text
                          style={[
                            styles.amtGlyph,
                            t.outflow > 0
                              ? styles.amtOutGlyph
                              : styles.amtInGlyph,
                          ]}
                        >
                          {t.outflow > 0 ? "−" : "+"}
                        </Text>
                        <Text
                          style={[
                            styles.amtValue,
                            t.outflow > 0
                              ? styles.amtOutValue
                              : styles.amtInValue,
                          ]}
                          numberOfLines={1}
                        >
                          {formatMoney(t.outflow > 0 ? t.outflow : t.inflow)}
                        </Text>
                      </View>
                    </View>
                    {showRunningBalance ? (
                      <Text style={[styles.regText, styles.runBal]}>
                        {runningBalances.has(t.id)
                          ? formatMoney(runningBalances.get(t.id)!)
                          : ""}
                      </Text>
                    ) : null}
                    <ClearedBadge
                      status={t.cleared}
                      onApprove={
                        t.approved || t.cleared === "reconciled"
                          ? undefined
                          : () =>
                              void updateTransaction({
                                budgetId,
                                id: t.id,
                                patch: { approved: true },
                              })
                      }
                      onToggle={
                        t.approved && t.cleared !== "reconciled"
                          ? () => toggleCleared(t)
                          : undefined
                      }
                    />
                    <TxnMenuKebab
                      onOpen={(px, py) =>
                        anchorAt(px, py, (x, y) =>
                          setMenuTxn({ t, x, y }),
                        )
                      }
                    />
                  </Pressable>
                </TxnMenuTrigger>
              );
            }}
          />
          {selectedTxns.length > 0 ? (
            <SelectionBar
              count={selectedTxns.length}
              categories={categories}
              groups={budget.groups}
              onCategorize={(categoryId) =>
                patchSelected({ categoryId, approved: true })
              }
              onFlag={(flag) => patchSelected({ flag, approved: true })}
              onCleared={(cleared) => clearSelected(cleared)}
              allCleared={allCleared}
              canMatch={canMatch}
              hasMatched={hasMatched}
              onMatch={matchSelected}
              onUnmatch={unmatchSelected}
              onDuplicate={duplicateSelected}
              onMemo={memoSelected}
              onExport={exportSelected}
              onDelete={deleteSelected}
              moveTargets={moveTargets}
              onMoveTo={moveToSelected}
              onClose={() => setSelectedIds(new Set())}
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
      {/* reconcile confirm backdrop + popover (syscd-app-mbi): YNAB
          semantics — Yes reconciles everything instantly, No opens the
          statement-entry session */}
      {reconcileAnchor ? (
        <Pressable
          style={styles.scrimFill}
          onPress={() => setReconcileAnchor(null)}
          accessibilityLabel="Close reconcile question"
        />
      ) : null}
      {reconcileAnchor && selectedAccount ? (
        <View
          style={[
            styles.popover,
            { left: reconcileAnchor.x, top: reconcileAnchor.y },
          ]}
        >
          <Text style={styles.popoverText}>
            Is your current balance{" "}
            {formatMoney(workingBalance(selectedAccount))}?
          </Text>
          <View style={styles.popoverBtns}>
            <GhostButton label="No" onPress={confirmReconcileQuestion} />
            <IndigoButton label="Yes" onPress={() => void reconcileAllNow()} />
          </View>
        </View>
      ) : null}
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
  topbar: {
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: "800" },
  titlePhone: { fontSize: 17, flexShrink: 1 },
  topbarTrail: { marginLeft: "auto" },
  // Web-phone: the Reconcile button joins the trail, so items pack together
  // instead of pushing right.
  topbarTrailWeb: { flexDirection: "row", alignItems: "center", gap: 8 },
  unclearedRow: {
    alignSelf: "flex-start",
    marginTop: 2,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.indigoSoft,
  },
  unclearedRowOn: { backgroundColor: colors.indigo },
  unclearedText: { color: colors.indigo3, fontSize: 12, fontWeight: "700" },
  unclearedTextOn: { color: "#fff" },
  regrowCompact: { paddingVertical: 2 },
  txnCardCompact: { paddingVertical: 5 },
  body: { flex: 1, minHeight: 0 },
  scheduledPhone: { paddingHorizontal: 20, paddingBottom: 8 },
  bodyPhone: {},
  main: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  regAcctFace: { width: 16, height: 16 },
  regAcctCell: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  subtitle: { color: colors.faint, fontSize: 12, marginTop: 2 },
  iconBtn: { padding: 4, borderRadius: radius.sm },
  // Reconcile sits at the trailing edge of the title row.
  reconcileBtnWrap: { marginLeft: "auto" },
  topbarRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  topbarLeft: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  banner: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  bannerMain: { flexDirection: "row", alignItems: "center", gap: 10 },
  bannerBtns: { flexDirection: "row", alignItems: "center", gap: 8 },
  bannerDiff: { color: colors.yellowPillFg, fontWeight: "700" },
  runBal: { width: 84, textAlign: "right", color: colors.muted },
  reconcileError: { color: colors.redFg, fontSize: 12 },
  kvLabel: { color: colors.muted, fontSize: 13 },
  scrimFill: { ...StyleSheet.absoluteFill, zIndex: 29 },
  popover: {
    position: "absolute",
    zIndex: 30,
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    padding: 12,
    gap: 10,
    minWidth: 260,
  },
  popoverText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  popoverBtns: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
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
  checkCell: {
    width: 30,
    flexShrink: 0,
    alignItems: "center",
  },
  reghd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 5,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  reghdText: { color: colors.faint, fontSize: 11, letterSpacing: 0.5 },
  regrow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  regText: { color: colors.text, fontSize: 13, fontVariant: ["tabular-nums"] },
  // Signed amount pill (import-style): − red / + green, single AMOUNT column.
  amtBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: 1,
    paddingHorizontal: 5,
    maxWidth: 118,
  },
  amtOut: { borderColor: colors.red, backgroundColor: colors.redPillBg },
  amtIn: { borderColor: colors.green, backgroundColor: colors.greenPillBg },
  amtGlyph: { fontSize: 13, fontWeight: "600" },
  amtOutGlyph: { color: colors.redFg },
  amtInGlyph: { color: colors.greenPillFg },
  amtValue: { color: colors.text, fontSize: 13, fontVariant: ["tabular-nums"] },
  amtOutValue: { color: colors.redFg },
  amtInValue: { color: colors.greenPillFg },
  // Row context-menu trigger (syscd-app-42f).
  rowMenuBtn: { width: 24, alignItems: "center", justifyContent: "center" },
  rowMenuBtnText: { color: colors.faint, fontSize: 15, fontWeight: "700" },
  // Upcoming repeat-rule occurrence (syscd-app-pya): dimmed row + Repeat chip.
  regrowUpcoming: { opacity: 0.55 },
  upcomingPill: {
    fontSize: 10,
    fontWeight: "700",
    paddingVertical: 1,
    paddingHorizontal: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.grayPillBg,
    color: colors.muted,
    overflow: "hidden",
  },
  tagPill: {
    fontSize: 11,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.grayPillBg,
    color: colors.muted,
    overflow: "hidden",
  },
  tagPillWarn: {
    backgroundColor: colors.yellowPillBg,
    color: colors.yellowPillFg,
  },
  txnCard: {
    paddingHorizontal: 20,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  // Phone two-line row (tk-boxi): line 1 = payee + Repeat + amount, badge
  // trailing; line 2 = category + account under the payee.
  txnL1Phone: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  txnLeadPhone: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  txnL2Phone: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 3,
  },
  txnPayee: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 13,
    flexShrink: 1,
    minWidth: 40,
  },
  txnAcct: { color: colors.faint, fontSize: 11, flexShrink: 1 },
});
