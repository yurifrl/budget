/**
 * Phone: the row-tap numpad edits one category's assigned amount live (the
 * row's ASSIGNED cell renders the engine state as a YNAB-style equation);
 * its options open move money / auto-assign / the full detail page.
 */
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, SectionList, View } from 'react-native';

import type { PlanItem, PlanSection } from '../../domain/planSections';
import { EMPTY_NUMPAD_STATE, applyNumpadKey, type NumpadKey, type NumpadState } from '../../domain/quickmath';
import { numpadAlignOffset } from './planGeometry.logic';
import type { RowRefs } from './types';

export function usePlanNumpad(reportNumpadOpen: (open: boolean) => void, rowRefs: RowRefs) {
  const [numpadId, setNumpadId] = useState<string | null>(null);
  const [numpadState, setNumpadState] = useState<NumpadState>(EMPTY_NUMPAD_STATE);
  // qitk (T3): non-modal numpad panel — planListRef scrolls the tapped row
  // above the panel, listOffsetRef tracks the scroll offset for the delta math.
  const planListRef = useRef<SectionList<PlanItem, PlanSection> | null>(null);
  const listOffsetRef = useRef(0);
  const panelRef = useRef<ComponentRef<typeof View>>(null);

  // The shell slides its ＋ FAB down while the panel is open — it sits
  // exactly over the keypad's bottom-right keys otherwise. The setter is a
  // stable useState fn (the shell object itself re-memoizes), so depending on
  // it alone can't ping-pong the state.
  useEffect(() => {
    reportNumpadOpen(numpadId !== null);
    return () => reportNumpadOpen(false);
  }, [numpadId, reportNumpadOpen]);

  // qitk (T3): on open/switch, scroll the tapped row so it sits directly
  // above the panel (8px gap). Measures row and panel in window coords and
  // scrolls by the delta — afterwards the user scrolls freely. Instant (not
  // animated) so a quick second tap re-measures a settled offset.
  useEffect(() => {
    if (!numpadId) return;
    // rAF: let the freshly mounted panel finish layout before measuring
    // (Fabric layout may not have committed when effects run).
    const raf = requestAnimationFrame(() => {
      const row = rowRefs.current.get(numpadId);
      if (!row) return;
      row.measureInWindow((_x, rowY, _w, rowH) => {
        panelRef.current?.measureInWindow((_px, panelY) => {
          const y = numpadAlignOffset({ y: rowY, height: rowH }, panelY, listOffsetRef.current);
          if (y === null) return;
          planListRef.current?.getScrollResponder()?.scrollTo({ y, animated: false });
        });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [numpadId, rowRefs]);

  /** Closes the non-modal numpad panel, discarding any pending draft. */
  const closeNumpad = () => {
    setNumpadId(null);
    setNumpadState(EMPTY_NUMPAD_STATE);
  };

  return {
    numpadId,
    numpadState,
    planListRef,
    panelRef,
    closeNumpad,
    /** Open the editor on a row (or switch to it): pristine start. */
    openNumpad: (categoryId: string) => {
      setNumpadId(categoryId);
      setNumpadState(EMPTY_NUMPAD_STATE);
    },
    onNumpadKey: (key: NumpadKey) => setNumpadState((prev) => applyNumpadKey(prev, key)),
    onListScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      listOffsetRef.current = e.nativeEvent.contentOffset.y;
    },
  };
}

export type PlanNumpad = ReturnType<typeof usePlanNumpad>;
