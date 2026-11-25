/**
 * One expanded bundle's rows, paged at the queue contract's 200-row cap. The
 * first page is cached by RTK Query like any queue read and replaces what was
 * shown whenever it is re-read (so a filed row leaves the card); "show more
 * rows" fetches the next offset and appends (deduped by transaction id). Changing
 * the open bundle resets the pages without a render-time race on the offset.
 */

import { skipToken } from '@reduxjs/toolkit/query';
import { useEffect, useState } from 'react';

import { useGetCategorizeQueueQuery, type CategorizeQueueRow } from '@/budget/data/api';

import type { ShownBundle } from './queue.logic';

const PAGE_SIZE = 200;

interface PageState {
  bundleKey: string | null;
  offset: number;
}

interface Collected {
  bundleKey: string | null;
  rows: CategorizeQueueRow[];
}

export function useBundleRows(budgetId: string | null, bundle: ShownBundle | null) {
  const bundleKey = bundle?.bundle_key ?? null;
  const [page, setPage] = useState<PageState>({ bundleKey, offset: 0 });
  const [collected, setCollected] = useState<Collected>({ bundleKey: null, rows: [] });
  // A bundle opened in a previous render starts at row 0, not at the old offset.
  const offset = page.bundleKey === bundleKey ? page.offset : 0;

  const query = useGetCategorizeQueueQuery(
    budgetId && bundle ? { budgetId, bundle: bundle.bundle_key, limit: PAGE_SIZE, offset } : skipToken,
  );

  useEffect(() => {
    if (!bundle || !query.data) return;
    const rows = query.data.rows;
    setCollected((prev) => {
      // The first page is the bundle as it is now (a filed row has left it);
      // only the pages after it are appended.
      if (offset === 0 || prev.bundleKey !== bundle.bundle_key) return { bundleKey: bundle.bundle_key, rows };
      const seen = new Set(prev.rows.map((row) => row.transaction_id));
      return {
        bundleKey: bundle.bundle_key,
        rows: [...prev.rows, ...rows.filter((row) => !seen.has(row.transaction_id))],
      };
    });
  }, [bundle, offset, query.data]);

  const rows = collected.bundleKey === bundleKey ? collected.rows : [];
  // Paged against what the server counts: rows waiting in the strip are still listed by it.
  const total = bundle?.serverCount ?? 0;
  return {
    rows,
    loading: query.isLoading,
    loadingMore: query.isFetching && !query.isLoading,
    error: query.isError,
    refetch: query.refetch,
    hasMore: rows.length < total,
    loadMore: () => setPage({ bundleKey, offset: rows.length }),
  };
}
