/**
 * State of the One by one view: which line is in focus, how many were done this
 * visit, the "✓ filed to X" lines of what was done, and what each action does.
 * The lines are Jev's transfer answers first, then the queue rows; both answer
 * to the same keys. Filing is optimistic: the accept flow hides the line at
 * once, so focus falls to the next one without waiting for the server. Undo
 * hands focus back to the line it restored.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TextInputInstance } from 'react-native';

import type { CategorizeCounts, CategorizeQueueRow } from '@/budget/data/api';

import { canUndo as canUndoState, pendingSkips, type UndoEntry } from './accept.logic';
import type { CategorizeKeyAction } from './keys.logic';
import {
  dropFiled,
  entriesOf,
  filedLineOf,
  filedToText,
  orderQueue,
  progressView,
  recordFiled,
  remainingCount,
  resolveFocus,
  transferFiledTo,
  type FiledEntry,
  type OneEntry,
  type ProgressView,
} from './oneByOne.logic';
import type { PickedCategory } from './page.logic';
import { t } from './i18n';
import { topSuggestions } from './queue.logic';
import type { TransferActions, TransferItem } from './transfer.logic';
import type { CategorizeAccept } from './useCategorizeAccept';
import { useCategorizeKeys } from './useCategorizeKeys';

export interface OneByOne {
  /** The lines to answer: transfer answers first, then the queue rows. */
  entries: OneEntry[];
  /** Lines done this visit, oldest first; shown dimmed above the list. */
  filed: FiledEntry[];
  focused: OneEntry | null;
  /** Rows of the category queue still to answer (Jev's transfer answers not counted). */
  queueRemaining: number;
  /** Jev's transfer answers still listed. */
  answers: number;
  /** Everything still to answer here: queue rows plus Jev's transfer answers. */
  remaining: number;
  progress: ProgressView;
  canUndo: boolean;
  /** Part of the search picker's key: bumping it clears the typed text. */
  searchReset: number;
  /** Skips still waiting for their own timer, each cancellable. */
  pendingSkips: Extract<UndoEntry, { kind: 'skip' }>[];
  searchRef: React.RefObject<TextInputInstance | null>;
  focusEntry: (entry: OneEntry) => void;
  file: (index: number) => void;
  pick: (category: PickedCategory) => void;
  refuse: () => void;
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
  transfers,
  answerCount,
  counts,
  accept,
  transferActions,
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
  /** Jev's transfer answers, which lead the list. */
  transfers: readonly TransferItem[];
  /** Every transfer answer the read lists, answered or not: the counter's second number. */
  answerCount: number;
  counts: Pick<CategorizeCounts, 'left_to_categorize'> | undefined;
  accept: CategorizeAccept;
  transferActions: TransferActions;
}): OneByOne {
  const ordered = useMemo(() => orderQueue(rows), [rows]);
  const entries = useMemo(() => entriesOf(ordered, transfers), [ordered, transfers]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const lastIndex = useRef(0);
  const [done, setDone] = useState(0);
  const [filed, setFiled] = useState<FiledEntry[]>([]);
  /** Bumped by Escape in the search: the picker remounts, so its text is gone. */
  const [searchReset, setSearchReset] = useState(0);
  const revertedSeen = useRef(0);
  const searchRef = useRef<TextInputInstance>(null);

  const focus = resolveFocus(entries, focusedId, lastIndex.current);
  const focused = focus.row;
  // A filed line's id stays in `focusedId` but no longer matches: focus then
  // falls to the line at the same place. If it comes back (a failed accept, an
  // undo) it matches again and takes focus back.
  useEffect(() => {
    lastIndex.current = focus.index;
  }, [focus.index]);

  const hidden = useMemo(() => new Set(accept.state.hiddenIds), [accept.state.hiddenIds]);
  // The two numbers the counter adds, each from a read: the queue's rows (its
  // own count less the ones the page has answered) and Jev's answers as the
  // list reads them. Nothing here depends on a row being hidden optimistically,
  // so the counter and the header's subtitle always agree.
  const queueRemaining = remainingCount(counts, pageRows, hidden);
  const remaining = queueRemaining + answerCount;
  const progress = progressView(done, remaining);

  /** A line left the list by this person's hand: count it and show its line; take both back if it fails. */
  const finish = (request: Promise<boolean>, entry: OneEntry, text: string) => {
    setDone((n) => n + 1);
    setFiled((list) => recordFiled(list, filedLineOf(entry, text)));
    void request.then((ok) => {
      if (ok) return;
      setDone((n) => Math.max(0, n - 1));
      setFiled((list) => dropFiled(list, [entry.transaction_id]));
    });
  };

  const file = (index: number) => {
    if (!focused) return;
    if (focused.kind === 'transfer') {
      // One answer, one key: accepting is the only thing numbered here.
      if (index !== 0) return;
      const { item } = focused;
      finish(transferActions.accept(item), focused, transferFiledTo(item.transferAccountName));
      return;
    }
    const suggestion = topSuggestions(focused.row.suggestions)[index];
    if (suggestion) {
      finish(accept.fileRow(focused.row, suggestion), focused, filedToText(suggestion.category_name));
    }
  };
  const pick = (category: PickedCategory) => {
    if (!focused || focused.kind === 'transfer') return;
    finish(accept.pickCategory(focused.row, category), focused, filedToText(category.label));
  };
  const refuse = () => {
    if (!focused) return;
    if (focused.kind === 'transfer') {
      finish(transferActions.refuse(focused.item), focused, t('transfer.refuse'));
      return;
    }
    // A queue row refuses nothing: the queue's own "leave" is the skip.
    skip();
  };
  const skip = () => {
    if (!focused) return;
    if (focused.kind === 'transfer') {
      finish(transferActions.skip(focused.item), focused, t('one.filedLeft'));
      return;
    }
    finish(Promise.resolve(accept.skipRow(focused.row)), focused, t('one.filedLeft'));
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
      case 'notTransfer':
        return refuse();
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
    suggestions: focused?.kind === 'transfer' ? 1 : focused ? topSuggestions(focused.row.suggestions).length : 0,
    transfer: focused?.kind === 'transfer',
    undoAvailable: canUndo,
    onAction: onKey,
  });
  return {
    entries,
    filed,
    focused,
    queueRemaining,
    answers: answerCount,
    remaining,
    progress,
    canUndo,
    searchReset,
    pendingSkips: pendingSkips(accept.state),
    searchRef,
    focusEntry: (entry) => setFocusedId(entry.transaction_id),
    file,
    pick,
    refuse,
    skip,
    undo,
    cancelSkip,
  };
}
