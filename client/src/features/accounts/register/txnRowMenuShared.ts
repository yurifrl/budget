/**
 * Shared logic for the register row's context menu (syscd-app-42f): the pure
 * CSV / match helpers plus `useTxnRowMenuActions`, the single hook wiring
 * every YNAB row-menu action to its mutation. Consumed by the desktop popover
 * (`TxnRowMenu`) and the native SwiftUI trigger (`TxnMenuTrigger.ios.tsx`),
 * so both presentations share one action surface.
 */

import { useMemo } from "react";
import { useRouter } from "expo-router";

import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import type {
  Budget,
  FlagColor,
  RepeatFrequency,
  Transaction,
} from "@/domain/types";
import {
  useAddRepeatRuleMutation,
  useAddTransactionMutation,
  useDeleteTransactionMutation,
  useUpdateTransactionMutation,
} from "@/budget/data/api";

/**
 * Match candidates (syscd-app-42f): live rows in the same account with the
 * exact same one-way amount — YNAB pairs an imported row with the manual row
 * for the same purchase. Pending upcoming occurrences and already-matched
 * rows are excluded.
 */
export function matchCandidates(
  txn: Transaction,
  budget: Budget,
): Transaction[] {
  return budget.transactions.filter(
    (t) =>
      t.id !== txn.id &&
      t.accountId === txn.accountId &&
      !t.upcoming &&
      !t.matchedTransactionId &&
      t.inflow === txn.inflow &&
      t.outflow === txn.outflow,
  );
}

/** CSV for Export (row menu + selection bar): YNAB-style header, one row per transaction. */
export function txnsCsv(txns: readonly Transaction[], budget: Budget): string {
  const esc = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
  // eslint-disable-next-line budget-i18n/no-untranslated-string -- CSV column headers of the export file (YNAB-style data format), not UI text
  const header = ["Date", "Payee", "Category", "Memo", "Outflow", "Inflow", "Cleared"];
  return [
    header.join(","),
    ...txns.map((txn) => {
      const cat =
        budget.categories.find((c) => c.id === txn.categoryId)?.name ?? "";
      return [
        txn.date,
        esc(txn.payee),
        esc(cat),
        esc(txn.memo ?? ""),
        (txn.outflow / 100).toFixed(2),
        (txn.inflow / 100).toFixed(2),
        txn.cleared,
      ].join(",");
    }),
  ].join("\n");
}

/** Trigger a browser download for the exported CSV (web-only call sites). */
export function downloadCsv(name: string, csv: string): void {
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Hand a generated CSV to the native share sheet (iOS/Android call sites). */
async function shareCsvFile(name: string, csv: string): Promise<void> {
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) return;
  const fileUri = `${cacheDir}${encodeURIComponent(name)}`;
  await FileSystem.writeAsStringAsync(fileUri, csv, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  await Sharing.shareAsync(fileUri, {
    mimeType: "text/csv",
    UTI: "public.comma-separated-values-text",
  });
}

/**
 * Every YNAB row-menu action for one transaction, shared by the desktop
 * popover and the native SwiftUI trigger: approve/reject, cleared flips,
 * match/unmatch, duplicate, make repeating, flag, categorize, move, export,
 * details and delete — each closing via `onClose` after the mutation settles.
 */
export function useTxnRowMenuActions({
  txn,
  budget,
  budgetId,
  onClose,
}: {
  txn: Transaction;
  budget: Budget;
  budgetId: string;
  /** Runs after each action (desktop dismisses its popover; native no-ops). */
  onClose: () => void;
}) {
  const [addTransaction] = useAddTransactionMutation();
  const [updateTransaction] = useUpdateTransactionMutation();
  const [deleteTransaction, deleteState] = useDeleteTransactionMutation();
  const [addRepeatRule, repeatState] = useAddRepeatRuleMutation();
  const router = useRouter();

  const candidates = useMemo(() => matchCandidates(txn, budget), [txn, budget]);
  const matched = txn.matchedTransactionId
    ? budget.transactions.find((t) => t.id === txn.matchedTransactionId)
    : undefined;

  const makeRepeat = (frequency: RepeatFrequency) => {
    void addRepeatRule({
      budgetId,
      accountId: txn.accountId,
      payee: txn.payee,
      categoryId: txn.categoryId,
      memo: txn.memo ?? "",
      outflowCents: txn.outflow,
      inflowCents: txn.inflow,
      frequency,
      monthLastDay: false,
      attachTransactionId: txn.id,
    })
      .unwrap()
      .then(() => onClose())
      .catch(() => undefined);
  };

  const moveTo = (accountId: string) => {
    void updateTransaction({
      budgetId,
      id: txn.id,
      patch: { accountId },
    })
      .unwrap()
      .then(() => onClose())
      .catch(() => undefined);
  };

  const duplicate = () => {
    void addTransaction({
      budgetId,
      txn: {
        accountId: txn.accountId,
        date: txn.date,
        payee: txn.payee,
        categoryId: txn.categoryId,
        memo: txn.memo ?? "",
        outflowCents: txn.outflow,
        inflowCents: txn.inflow,
        cleared: txn.cleared,
        approved: txn.approved,
        flag: txn.flag ?? null,
        repeat: txn.repeat,
      },
    })
      .unwrap()
      .then(() => onClose())
      .catch(() => undefined);
  };

  const doDelete = () => {
    void deleteTransaction({ budgetId, id: txn.id })
      .unwrap()
      .then(() => onClose())
      .catch(() => undefined);
  };

  const match = (other: Transaction) => {
    void updateTransaction({
      budgetId,
      id: txn.id,
      patch: { matchedTransactionId: other.id },
    })
      .unwrap()
      .then(() =>
        updateTransaction({
          budgetId,
          id: other.id,
          patch: { matchedTransactionId: txn.id },
        }).unwrap(),
      )
      .then(() => onClose())
      .catch(() => undefined);
  };

  const unmatch = () => {
    const otherId = txn.matchedTransactionId;
    void updateTransaction({
      budgetId,
      id: txn.id,
      patch: { matchedTransactionId: null },
    })
      .unwrap()
      .then(() =>
        otherId
          ? updateTransaction({
              budgetId,
              id: otherId,
              patch: { matchedTransactionId: null },
            }).unwrap()
          : undefined,
      )
      .then(() => onClose())
      .catch(() => undefined);
  };

  const approve = () => {
    void updateTransaction({
      budgetId,
      id: txn.id,
      patch: { approved: true },
    })
      .unwrap()
      .then(() => onClose())
      .catch(() => undefined);
  };

  // YNAB's Reject only applies to imported, unapproved rows and removes the
  // transaction (nothing to approve-and-keep). Manual rows have it disabled.
  const reject = () => {
    void deleteTransaction({ budgetId, id: txn.id })
      .unwrap()
      .then(() => onClose())
      .catch(() => undefined);
  };

  // Cleared flips move the balance buckets with the state; the server derives
  // the deltas from the row before/after the edit.
  const setClear = (cleared: "cleared" | "uncleared") => {
    void updateTransaction({ budgetId, id: txn.id, patch: { cleared } })
      .unwrap()
      .then(() => onClose())
      .catch(() => undefined);
  };

  // Flag / category edits don't touch balances.
  const setFlag = (flag: FlagColor | null) => {
    void updateTransaction({
      budgetId,
      id: txn.id,
      patch: { flag },
    })
      .unwrap()
      .then(() => onClose())
      .catch(() => undefined);
  };

  const categorize = (categoryId: string | null) => {
    void updateTransaction({
      budgetId,
      id: txn.id,
      patch: { categoryId },
    })
      .unwrap()
      .then(() => onClose())
      .catch(() => undefined);
  };

  const exportCsv = () => {
    const name = `transaction-${txn.date}-${
      txn.payee.trim().toLowerCase().replaceAll(/\s+/g, "-") || "unnamed"
    }.csv`;
    const csv = txnsCsv([txn], budget);
    if (process.env.EXPO_OS === "web") {
      downloadCsv(name, csv);
    } else {
      void shareCsvFile(name, csv);
    }
    onClose();
  };

  // Details: the transaction's own page, deep-linkable (/transaction?id=…).
  const openDetails = () => {
    onClose();
    router.push({ pathname: "/transaction", params: { id: txn.id } });
  };

  const moveTargets = budget.accounts.filter((a) => a.id !== txn.accountId);
  const busy = deleteState.isLoading || repeatState.isLoading;

  return {
    approve,
    reject,
    setClear,
    setFlag,
    categorize,
    makeRepeat,
    moveTo,
    duplicate,
    doDelete,
    match,
    unmatch,
    exportCsv,
    openDetails,
    candidates,
    matched,
    moveTargets,
    busy,
  };
}
