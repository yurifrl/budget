/**
 * useAccountSync: the server-side view of the selected account: the raw
 * account rows (the edit-account modal works on them) and the toolbar's bank
 * sync chip.
 */

import { useGetAccountsQuery, useGetConnectionsQuery } from '../../data/api';
import { connectionStatusView, formatSyncStamp } from '../../model/banks/connections';

export function useAccountSync(budgetId: string | null | undefined, selectedAccountId: string | null) {
  // Raw account rows (milli balances) — feeds the edit-account modal, which
  // works on server rows, not the domain model.
  const accountRows = useGetAccountsQuery(budgetId ? { budgetId } : { budgetId: '' }, { skip: !budgetId });
  // Sync status for the toolbar chip: the selected account's connection.
  const connectionsQuery = useGetConnectionsQuery(undefined, { skip: !budgetId });

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
          bank: linkedRow.institution ?? linkedConnection.institution ?? linkedConnection.provider,
          ...connectionStatusView(linkedConnection.status),
          stamp: linkedConnection.last_synced_at ? formatSyncStamp(linkedConnection.last_synced_at) : null,
        }
      : undefined;

  return { accountRows: accountRows.data, syncStatus };
}
