/**
 * State of the One by one view: which row is in focus, how many were done this
 * visit, and what each action does. Filing is optimistic: the accept flow hides
 * the row at once, so focus falls to the next row without waiting for the
 * server. Undo hands focus back to the row it restored.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TextInputInstance } from 'react-native';

import type { CategorizeCounts, CategorizeQueueRow } from '@/budget/data/api';

import { canUndo as canUndoState } from './accept.logic';
import type { CategorizeAccept } from './useCategorizeAccept';
import type { CategorizeKeyAction } from './keys.logic';
import { orderQueue, progressView, remainingCount, resolveFocus, type ProgressView } from './oneByOne.logic';
import type { PickedCategory } from './page.logic';
import { topSuggestions } from './queue.logic';
import { useCategorizeKeys } from './useCategorizeKeys';

export interface OneByOne {
  rows: CategorizeQueueRow[];
  focused: CategorizeQueueRow | null;
  progress: ProgressView;
  canUndo: boolean;
  searchRef: React.RefObject<TextInputInstance | null>;
  focusRow: (row: CategorizeQueueRow) => void;
  file: (index: number) => void;
  pick: (category: PickedCategory) => void;
  skip: () => void;
  undo: () => void;
}

export function useOneByOne({
  enabled,
  rows,
  pageRows,
  counts,
  accept,
}: {
  enabled: boolean;
  /** The queue page without optimistically hidden rows. */
  rows: readonly CategorizeQueueRow[];
  /** The queue page as read (hidden rows included): for the remaining count. */
  pageRows: readonly CategorizeQueueRow[];
  counts: Pick<CategorizeCounts, 'left_to_categorize'> | undefined;
  accept: CategorizeAccept;
}): OneByOne {
  const ordered = useMemo(() => orderQueue(rows), [rows]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const lastIndex = useRef(0);
  const [done, setDone] = useState(0);
  const searchRef = useRef<TextInputInstance>(null);

  const focus = resolveFocus(ordered, focusedId, lastIndex.current);
  const focused = focus.row;
  // A filed row's id stays in `focusedId` but no longer matches: focus then
  // falls to the row at the same place. If the row comes back (a failed accept,
  // an undo) it matches again and takes focus back.
  useEffect(() => {
    lastIndex.current = focus.index;
  }, [focus.index]);

  const hidden = useMemo(() => new Set(accept.state.hiddenIds), [accept.state.hiddenIds]);
  const remaining = remainingCount(counts, pageRows, hidden);
  const progress = progressView(done, remaining);

  /** A row left the queue by this person's hand: count it, undo the count if the server refuses. */
  const finish = (request: Promise<boolean>) => {
    setDone((n) => n + 1);
    void request.then((ok) => {
      if (!ok) setDone((n) => Math.max(0, n - 1));
    });
  };

  const file = (index: number) => {
    if (!focused) return;
    const suggestion = topSuggestions(focused.suggestions)[index];
    if (suggestion) finish(accept.fileRow(focused, suggestion));
  };
  const pick = (category: PickedCategory) => {
    if (focused) finish(accept.pickCategory(focused, category));
  };
  const skip = () => {
    if (focused) finish(accept.skipRow(focused));
  };
  const undo = () => {
    void accept.undoLast().then((restored) => {
      if (restored.length === 0) return;
      setDone((n) => Math.max(0, n - restored.length));
      setFocusedId(restored[0] ?? null);
    });
  };

  const canUndo = canUndoState(accept.state);

  const onKey = (action: CategorizeKeyAction) => {
    switch (action.kind) {
      case 'file':
        return file(action.index);
      case 'fileTop':
        return file(0);
      case 'skip':
        return skip();
      case 'focusSearch':
        return searchRef.current?.focus();
      case 'undo':
        return undo();
    }
  };
  useCategorizeKeys({
    enabled: enabled && focused !== null,
    suggestions: focused ? topSuggestions(focused.suggestions).length : 0,
    undoAvailable: canUndo,
    onAction: onKey,
  });

  return {
    rows: ordered,
    focused,
    progress,
    canUndo,
    searchRef,
    focusRow: (row) => setFocusedId(row.transaction_id),
    file,
    pick,
    skip,
    undo,
  };
}
