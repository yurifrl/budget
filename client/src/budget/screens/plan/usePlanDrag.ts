/**
 * Web pointer drag on the plan grid (YNAB parity, syscd-app-42c): grab a row
 * anywhere except the checkbox, drop it between rows (reorder) or on the
 * middle of one (bundle). Target math is domain/planDrop.ts.
 */
import { useRef, useState } from 'react';

import type { DropTarget } from '../../domain/bundleDrop';
import { computeDropTarget, type RowRect } from '../../domain/planDrop';
import type { Category } from '../../domain/types';
import type { RowRefs } from './types';

export function usePlanDrag({
  isDesktop,
  rowOrder,
  rowRefs,
  onDrop,
}: {
  isDesktop: boolean;
  /** Drop-target row keys in display order. */
  rowOrder: readonly string[];
  rowRefs: RowRefs;
  /** Persist the drop (domain/bundleDrop.ts plans the moves + bundle op). */
  onDrop: (dragId: string, target: DropTarget) => unknown;
}) {
  const [drag, setDrag] = useState<{ id: string; dy: number } | null>(null);
  const [dropAt, setDropAt] = useState<DropTarget | null>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const dropAtRef = useRef<DropTarget | null>(null);
  const rectCache = useRef(new Map<string, RowRect>());

  const commitDrag = () => {
    const st = dragRef.current;
    const target = dropAtRef.current;
    dragRef.current = null;
    dropAtRef.current = null;
    rectCache.current.clear();
    setDrag(null);
    setDropAt(null);
    if (!st || !st.active || !target) return;
    // The pointerup that ends the drag also lands as a click — swallow it.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 350);
    void onDrop(st.id, target);
  };

  /** Web pointer drag on the plan grid: grab anywhere except the checkbox. */
  const onRowPointerDown = (
    c: Category,
    e: { stopPropagation: () => void; nativeEvent: { pageX: number; pageY: number } },
  ) => {
    e.stopPropagation();
    if (process.env.EXPO_OS !== 'web' || !isDesktop) return;
    dragRef.current = { id: c.id, startX: e.nativeEvent.pageX, startY: e.nativeEvent.pageY, active: false };
    dropAtRef.current = null;
    const onMove = (ev: globalThis.PointerEvent) => {
      const cur = dragRef.current;
      if (!cur || cur.id !== c.id) return;
      if (!cur.active && Math.hypot(ev.pageX - cur.startX, ev.pageY - cur.startY) > 8) {
        cur.active = true;
        setDrag({ id: c.id, dy: 0 });
        for (const rowId of rowOrder) {
          rowRefs.current
            .get(rowId)
            ?.measureInWindow((x, wy, w, h) => rectCache.current.set(rowId, { top: wy, bottom: wy + h }));
        }
      }
      if (!cur.active) return;
      const dy = ev.pageY - cur.startY;
      setDrag({ id: c.id, dy });
      const target = computeDropTarget(ev.pageY, c.id, rowOrder, rectCache.current);
      dropAtRef.current = target;
      setDropAt(target);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      commitDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return { drag, dropAt, suppressClickRef, onRowPointerDown };
}

export type PlanDrag = ReturnType<typeof usePlanDrag>;
