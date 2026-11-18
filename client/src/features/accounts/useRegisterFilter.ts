/**
 * useRegisterFilter: the register's scope, view options and search for the
 * Accounts screen. Owns the toolbar/banner filter state and derives the row
 * lists (scope, unapproved queue, visible, register vs scheduled) through the
 * pure rules in domain/register.
 */

import { useMemo, useState } from 'react';

import { todayIso } from '@/domain/format';
import { filterRegisterTxns, scopeRegisterTxns, splitScheduled } from '@/domain/register';
import type { Budget, Cents } from '@/domain/types';
import type { RegisterDensity } from './AccountsToolbar';

/** Stable empty array so `visibleTxns` deps stay referentially equal while loading. */
const EMPTY_CATEGORIES: Budget['categories'] = [];

export function useRegisterFilter({
  budget,
  selectedAccountId,
  parseMoney,
}: {
  /** Undefined while the budget query loads: every list is then empty. */
  budget: Budget | null | undefined;
  /** null = All Accounts. */
  selectedAccountId: string | null;
  parseMoney: (input: string) => Cents;
}) {
  // Closed-account transactions are hidden in All Accounts unless shown
  // (closed accounts are immutable; YNAB parity).
  const [showClosedTxns, setShowClosedTxns] = useState(false);
  // Header state: approval-banner filter (View all / View), row density and
  // the register search query. Undo/Redo: syscd-app-ijn.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [showUnapprovedOnly, setShowUnapprovedOnly] = useState(false);
  const [density, setDensity] = useState<RegisterDensity>('comfortable');
  const [searchQuery, setSearchQuery] = useState('');
  // YNAB view options: reconciled rows are hidden unless shown; running
  // balance column off by default; date range filters the register
  // (syscd-app-ojj).
  const [showReconciled, setShowReconciled] = useState(false);
  const [showRunningBalance, setShowRunningBalance] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const transactions = useMemo(
    () => (budget ? scopeRegisterTxns(budget, selectedAccountId, showClosedTxns) : []),
    [budget, selectedAccountId, showClosedTxns],
  );

  // Unapproved count in the unfiltered scope (account selection applies):
  // drives the banner and its View filter, independent of the search query.
  const unapprovedTxns = useMemo(() => transactions.filter((t) => !t.approved), [transactions]);

  // An empty category fallback keeps the memos valid while the budget query
  // loads.
  const categories = budget?.categories ?? EMPTY_CATEGORIES;

  const visibleTxns = useMemo(
    () =>
      filterRegisterTxns(
        transactions,
        { showReconciled, showUnapprovedOnly, dateFrom, dateTo, searchQuery },
        categories,
        parseMoney,
      ),
    [transactions, categories, showReconciled, showUnapprovedOnly, dateFrom, dateTo, searchQuery, parseMoney],
  );

  const { register: registerTxns, scheduled: scheduledTxns } = useMemo(
    () => splitScheduled(visibleTxns, todayIso()),
    [visibleTxns],
  );

  return {
    transactions,
    unapprovedTxns,
    categories,
    registerTxns,
    scheduledTxns,
    showClosedTxns,
    setShowClosedTxns,
    bannerDismissed,
    showUnapprovedOnly,
    toggleUnapprovedOnly: () => setShowUnapprovedOnly(!showUnapprovedOnly),
    /** Banner ✕: hides the banner for the session and drops its filter. */
    dismissBanner: () => {
      setBannerDismissed(true);
      setShowUnapprovedOnly(false);
    },
    density,
    setDensity,
    searchQuery,
    /** Typing a search leaves the unapproved-only view. */
    changeSearch: (q: string) => {
      setSearchQuery(q);
      if (q) setShowUnapprovedOnly(false);
    },
    showReconciled,
    setShowReconciled,
    showRunningBalance,
    setShowRunningBalance,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
  };
}
