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

import { canUndo as canUndoState } from './accept.logic';
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
  const [filed, setFiled] = useState<FiledEntry[]>([]);
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
      case 'typeToSearch':
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
    filed,
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
