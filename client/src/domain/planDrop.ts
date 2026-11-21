/**
 * Plan-grid drag: which row the pointer targets and the text of a
 * centre-drop highlight. Pure; the screen measures the row rects.
 * (What a drop then does is planned in bundleDrop.ts.)
 */
import { BUNDLE_ROW_PREFIX, type DropTarget } from './bundleDrop';
import { dropIntent } from './bundles';
import { t } from './i18n';
import type { Bundle, Category } from './types';

export interface RowRect {
  top: number;
  bottom: number;
}

/**
 * The drop target for pointer `y` (same coordinate space as `rects`) while
 * dragging `dragId`. `rowOrder` is the display order; rows with no measured
 * rect are skipped, the dragged row is never a target.
 */
export function computeDropTarget(
  y: number,
  dragId: string,
  rowOrder: readonly string[],
  rects: ReadonlyMap<string, RowRect>,
): DropTarget | null {
  // Over a row: top/bottom quarter reorders, the middle half bundles.
  for (const rowId of rowOrder) {
    if (rowId === dragId) continue;
    const rect = rects.get(rowId);
    if (rect && y >= rect.top && y <= rect.bottom) return { rowId, intent: dropIntent(y, rect) };
  }
  // Between rows / past the ends: nearest edge.
  let best: { rowId: string; intent: 'before' | 'after'; dist: number } | null = null;
  for (const rowId of rowOrder) {
    if (rowId === dragId) continue;
    const rect = rects.get(rowId);
    if (!rect) continue;
    const before = y < (rect.top + rect.bottom) / 2;
    const dist = Math.abs(y - (before ? rect.top : rect.bottom));
    if (!best || dist < best.dist) best = { rowId, intent: before ? 'before' : 'after', dist };
  }
  return best ? { rowId: best.rowId, intent: best.intent } : null;
}

/** Highlight text for a center drop: "Add to Medicines" / "Bundle with Doctor". */
export function dropLabel(
  target: Pick<DropTarget, 'rowId'>,
  categories: readonly Pick<Category, 'id' | 'name' | 'bundleId'>[],
  bundles: readonly Bundle[],
): string {
  const bundleId = target.rowId.startsWith(BUNDLE_ROW_PREFIX)
    ? target.rowId.slice(BUNDLE_ROW_PREFIX.length)
    : categories.find((c) => c.id === target.rowId)?.bundleId;
  const bundle = bundleId ? bundles.find((b) => b.id === bundleId) : undefined;
  if (bundle) return t('drop.addTo', { name: bundle.name });
  return t('drop.bundleWith', { name: categories.find((c) => c.id === target.rowId)?.name ?? '' });
}
