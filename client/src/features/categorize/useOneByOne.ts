/**
 * State of the One by one view: which row is in focus, how many were done this
 * visit, the "✓ filed to X" lines of what was done, and what each action does.
 * Filing is optimistic: the accept flow hides the row at once, so focus falls
 * to the next row without waiting for the server. Undo hands focus back to the
 * row it restored.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TextInputInstance } from 'react-native';

import type { CategorizeCounts, CategorizeQueueRow } from '@/budget/data/api';

import { canUndo as canUndoState, pendingSkips, type UndoEntry } from './accept.logic';
import type { CategorizeKeyAction } from './keys.logic';
import {
  dropFiled,
  filedToText,
  orderQueue,
  progressView,
  recordFiled,
  remainingCount,
  resolveFocus,
  type FiledEntry,
  type ProgressView,
} from './oneByOne.logic';
import type { PickedCategory } from './page.logic';
import { t } from './i18n';
import { topSuggestions } from './queue.logic';
import type { CategorizeAccept } from './useCategorizeAccept';
import { useCategorizeKeys } from './useCategorizeKeys';

export interface OneByOne {
  rows: CategorizeQueueRow[];
  /** Rows done this visit, oldest first; shown dimmed above the queue. */
  filed: FiledEntry[];
  focused: CategorizeQueueRow | null;
  progress: ProgressView;
  canUndo: boolean;
  /** Part of the search picker's key: bumping it clears the typed text. */
  searchReset: number;
  /** Skips still waiting for their own timer, each cancellable. */
  pendingSkips: Extract<UndoEntry, { kind: 'skip' }>[];
  searchRef: React.RefObject<TextInputInstance | null>;
  focusRow: (row: CategorizeQueueRow) => void;
  file: (index: number) => void;
  pick: (category: PickedCategory) => void;
  skip: () => void;
  undo: () => void;
  cancelSkip: (transactionId: string) => void;
}

export function useOneByOne({
  enabled,
  rowKeys,
  rootRef,
  rows,
  pageRows,
  counts,
  accept,
}: {
  /** Keys are live (no overlay or reload in the way). */
  enabled: boolean;
  /** One by one: all shortcuts. Bundles: only Z, for the skips still pending. */
  rowKeys: boolean;
  rootRef: { current: unknown };
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
  const [filed, setFiled] = useState<FiledEntry[]>([]);
  /** Bumped by Escape in the search: the picker remounts, so its text is gone. */
  const [searchReset, setSearchReset] = useState(0);
  const revertedSeen = useRef(0);
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

  /** A row left the queue by this person's hand: count it and show its line; take both back if it fails. */
  const finish = (request: Promise<boolean>, row: CategorizeQueueRow, text: string) => {
    setDone((n) => n + 1);
    setFiled((list) => recordFiled(list, { row, text }));
    void request.then((ok) => {
      if (ok) return;
      setDone((n) => Math.max(0, n - 1));
      setFiled((list) => dropFiled(list, [row.transaction_id]));
    });
  };

  const file = (index: number) => {
    if (!focused) return;
    const suggestion = topSuggestions(focused.suggestions)[index];
    if (suggestion) finish(accept.fileRow(focused, suggestion), focused, filedToText(suggestion.category_name));
  };
  const pick = (category: PickedCategory) => {
    if (focused) finish(accept.pickCategory(focused, category), focused, filedToText(category.label));
  };
  const skip = () => {
    if (focused) finish(Promise.resolve(accept.skipRow(focused)), focused, t('one.filedLeft'));
  };
  const undo = () => {
    void accept.undoLast().then((restored) => {
      if (restored.length === 0) return;
      setDone((n) => Math.max(0, n - restored.length));
      setFiled((list) => dropFiled(list, restored));
      setFocusedId(restored[0] ?? null);
    });
  };

  // A skip taken back without the person asking (its send failed, or its row
  // left the queue another way): its "left uncategorized" line and its place in
  // the counter go with it. The error, when there is one, is already on screen.
  const reverted = accept.state.reverted;
  useEffect(() => {
    const fresh = reverted.slice(revertedSeen.current);
    if (fresh.length === 0) return;
    revertedSeen.current = reverted.length;
    setDone((n) => Math.max(0, n - fresh.length));
    setFiled((list) => dropFiled(list, fresh));
  }, [reverted]);

  const cancelSkip = (transactionId: string) => {
    if (!accept.cancelSkip(transactionId)) return;
    setDone((n) => Math.max(0, n - 1));
    setFiled((list) => dropFiled(list, [transactionId]));
    setFocusedId(transactionId);
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
      case 'leaveField':
        setSearchReset((n) => n + 1);
        return (document.activeElement as HTMLElement | null)?.blur?.();
      case 'undo':
        return undo();
    }
  };
  useCategorizeKeys({
    enabled: enabled && (rowKeys ? focused !== null : canUndo),
    scope: rowKeys ? 'row' : 'undoOnly',
    rootRef,
    suggestions: focused ? topSuggestions(focused.suggestions).length : 0,
    undoAvailable: canUndo,
    onAction: onKey,
  });

  return {
    rows: ordered,
    filed,
    focused,
    progress,
    canUndo,
    searchReset,
    pendingSkips: pendingSkips(accept.state),
    searchRef,
    focusRow: (row) => setFocusedId(row.transaction_id),
    file,
    pick,
    skip,
    undo,
    cancelSkip,
  };
}
