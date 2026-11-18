/**
 * Web/Android no-op counterpart of the iOS row-menu wrapper
 * (`TxnMenuTrigger.ios.tsx`): web keeps the desktop interaction model —
 * right-click/long-press on the row (`Pressable.onContextMenu`) and the ⋯
 * `TxnMenuKebab` anchored `TxnRowMenu` popup — so the wrapper renders its
 * children unchanged. It exists only so both platforms share one call-site
 * JSX shape.
 */
import type { ReactNode } from "react";

import type { Budget, Transaction } from "../../domain/types";

export function TxnMenuTrigger({
  children,
}: {
  txn: Transaction;
  budget: Budget;
  budgetId: string;
  onEditMemo: (txn: Transaction) => void;
  children: ReactNode;
}) {
  return <>{children}</>;
}
