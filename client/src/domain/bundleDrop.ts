/**
 * Pure planning for category moves and bundle edits (docs/category-bundles-design.md).
 * Shared by the Plan grid's pointer drag (web) and hold-to-drag (phone), the
 * selection-bar "Bundle…" and the category menus. Returns the contiguous
 * `sortOrder` writes for the existing reorder op plus the bundle op to run
 * AFTER it (the server clears `bundle_id` on cross-group moves).
 */
import type { DropIntent } from './bundles';
import type { Category } from './types';

type Cat = Pick<Category, 'id' | 'groupId' | 'bundleId'>;

export interface CategoryMove {
  id: string;
  groupId: string;
  sortOrder: number;
}

export type BundleOp =
  | { kind: 'none' }
  | { kind: 'leave'; categoryIds: string[] }
  | { kind: 'join'; categoryIds: string[]; bundleId: string }
  | { kind: 'create'; categoryIds: string[]; groupId: string };

export interface DropPlan {
  moves: CategoryMove[];
  bundleOp: BundleOp;
}

/** Row key of a bundle row in drop-target lists (category rows use their id). */
export const BUNDLE_ROW_PREFIX = 'bundle:';
export const bundleRowKey = (bundleId: string) => `${BUNDLE_ROW_PREFIX}${bundleId}`;

export interface DropTarget {
  /** A category id, or `bundle:<id>` for a bundle row. */
  rowId: string;
  intent: DropIntent;
}

/**
 * Move `ids` (kept in their current relative order) into `groupId`, right after
 * `afterId` / before `beforeId` (neither: at the end). Every touched group gets
 * contiguous sort orders; gaps left by moved rows are closed.
 */
export function gatherMoves(
  categories: readonly Cat[],
  ids: readonly string[],
  groupId: string,
  anchor: { afterId?: string; beforeId?: string },
): CategoryMove[] {
  const idSet = new Set(ids);
  const moving = categories.filter((c) => idSet.has(c.id));
  const moves: CategoryMove[] = [];
  const touched = new Set<string>([groupId, ...moving.map((c) => c.groupId)]);
  for (const gid of touched) {
    const rest = categories.filter((c) => c.groupId === gid && !idSet.has(c.id));
    let next: { id: string }[] = rest;
    if (gid === groupId) {
      const ai = anchor.afterId ? rest.findIndex((c) => c.id === anchor.afterId) : -1;
      const bi = anchor.beforeId ? rest.findIndex((c) => c.id === anchor.beforeId) : -1;
      const at = ai >= 0 ? ai + 1 : bi >= 0 ? bi : rest.length;
      next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    }
    next.forEach((c, i) => moves.push({ id: c.id, groupId: gid, sortOrder: i }));
  }
  return moves;
}

const childrenOf = (categories: readonly Cat[], bundleId: string) => categories.filter((c) => c.bundleId === bundleId);

/** Move `ids` into an existing bundle: they land right after its last child. */
export function planJoin(categories: readonly Cat[], ids: readonly string[], bundleId: string): DropPlan {
  const kids = childrenOf(categories, bundleId).filter((c) => !ids.includes(c.id));
  const last = kids[kids.length - 1];
  if (!last) return { moves: [], bundleOp: { kind: 'none' } };
  return {
    moves: gatherMoves(categories, ids, last.groupId, { afterId: last.id }),
    bundleOp: { kind: 'join', categoryIds: [...ids], bundleId },
  };
}

/** Bundle `ids` (≥ 2) in `groupId`: they gather at the first one's slot. */
export function planCreate(categories: readonly Cat[], ids: readonly string[], groupId: string): DropPlan {
  const ordered = categories.filter((c) => ids.includes(c.id));
  const inGroup = ordered.find((c) => c.groupId === groupId);
  const head = inGroup ?? ordered[0];
  if (!head || ordered.length < 2) return { moves: [], bundleOp: { kind: 'none' } };
  const tail = ordered.filter((c) => c.id !== head.id).map((c) => c.id);
  // Anchor on the head itself: move everything else after it.
  const moves = gatherMoves(categories, tail, groupId, {
    afterId: head.groupId === groupId ? head.id : undefined,
  });
  const headMoves = head.groupId === groupId ? [] : gatherMoves(categories, [head.id], groupId, {});
  return {
    moves: mergeMoves(moves, headMoves),
    bundleOp: {
      kind: 'create',
      categoryIds: ordered.map((c) => c.id),
      groupId,
    },
  };
}

function mergeMoves(a: CategoryMove[], b: CategoryMove[]): CategoryMove[] {
  if (!b.length) return a;
  const map = new Map(a.map((m) => [m.id, m]));
  for (const m of b) map.set(m.id, m);
  return [...map.values()];
}

/** What dropping `dragId` on `target` does. */
export function planDrop(categories: readonly Cat[], dragId: string, target: DropTarget): DropPlan {
  const none: DropPlan = { moves: [], bundleOp: { kind: 'none' } };
  const dragged = categories.find((c) => c.id === dragId);
  if (!dragged) return none;
  const isBundleRow = target.rowId.startsWith(BUNDLE_ROW_PREFIX);
  const targetBundleId = isBundleRow
    ? target.rowId.slice(BUNDLE_ROW_PREFIX.length)
    : categories.find((c) => c.id === target.rowId)?.bundleId;
  const targetCat = isBundleRow ? undefined : categories.find((c) => c.id === target.rowId);

  if (target.intent === 'bundle') {
    if (targetBundleId) {
      if (dragged.bundleId === targetBundleId) return none;
      return planJoin(categories, [dragId], targetBundleId);
    }
    if (!targetCat || targetCat.id === dragId) return none;
    // Create anchored on the target so the dragged row lands next to it.
    const moves = gatherMoves(categories, [dragId], targetCat.groupId, {
      afterId: targetCat.id,
    });
    return {
      moves,
      bundleOp: {
        kind: 'create',
        categoryIds: [targetCat.id, dragId],
        groupId: targetCat.groupId,
      },
    };
  }

  const before = target.intent === 'before';
  const leave: BundleOp = { kind: 'leave', categoryIds: [dragId] };
  if (targetBundleId) {
    const kids = childrenOf(categories, targetBundleId).filter((c) => c.id !== dragId);
    const first = kids[0];
    const last = kids[kids.length - 1];
    if (!first || !last) return none;
    const outsideTop = isBundleRow ? before : before && targetCat?.id === first.id;
    const outsideBottom = isBundleRow ? !before : !before && targetCat?.id === last.id;
    if (outsideTop || outsideBottom) {
      const moves = gatherMoves(
        categories,
        [dragId],
        first.groupId,
        outsideTop ? { beforeId: first.id } : { afterId: last.id },
      );
      return { moves, bundleOp: dragged.bundleId ? leave : { kind: 'none' } };
    }
    // Between two children: the row joins the bundle at that slot.
    const moves = gatherMoves(
      categories,
      [dragId],
      first.groupId,
      before ? { beforeId: targetCat!.id } : { afterId: targetCat!.id },
    );
    return {
      moves,
      bundleOp:
        dragged.bundleId === targetBundleId
          ? { kind: 'none' }
          : { kind: 'join', categoryIds: [dragId], bundleId: targetBundleId },
    };
  }
  if (!targetCat || targetCat.id === dragId) return none;
  const moves = gatherMoves(
    categories,
    [dragId],
    targetCat.groupId,
    before ? { beforeId: targetCat.id } : { afterId: targetCat.id },
  );
  const sameGroup = dragged.groupId === targetCat.groupId;
  return {
    moves,
    bundleOp: dragged.bundleId && sameGroup ? leave : { kind: 'none' },
  };
}
