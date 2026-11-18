import { describe, expect, test } from 'bun:test';

import { bundleRowKey, gatherMoves, planCreate, planDrop, planJoin } from './bundleDrop';

const c = (id: string, groupId: string, bundleId?: string) => ({
  id,
  groupId,
  bundleId,
});
const cats = [c('doc', 'h'), c('d1', 'h', 'b1'), c('d2', 'h', 'b1'), c('gym', 'h'), c('rent', 'f'), c('food', 'f')];
const order = (moves: { id: string; groupId: string; sortOrder: number }[], gid: string) =>
  moves
    .filter((m) => m.groupId === gid)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((m) => m.id);

describe('gatherMoves', () => {
  test('reorders within a group with contiguous sort orders', () => {
    expect(order(gatherMoves(cats, ['gym'], 'h', { beforeId: 'doc' }), 'h')).toEqual(['gym', 'doc', 'd1', 'd2']);
  });
  test('cross-group move closes the gap in the old group', () => {
    const m = gatherMoves(cats, ['rent'], 'h', { afterId: 'doc' });
    expect(order(m, 'h')).toEqual(['doc', 'rent', 'd1', 'd2', 'gym']);
    expect(order(m, 'f')).toEqual(['food']);
  });
});

describe('planDrop', () => {
  test('center on a plain category creates a bundle next to it', () => {
    const p = planDrop(cats, 'gym', { rowId: 'doc', intent: 'bundle' });
    expect(order(p.moves, 'h')).toEqual(['doc', 'gym', 'd1', 'd2']);
    expect(p.bundleOp).toEqual({
      kind: 'create',
      categoryIds: ['doc', 'gym'],
      groupId: 'h',
    });
  });
  test('center on a bundle row joins it after the last child (cross-group ok)', () => {
    const p = planDrop(cats, 'rent', {
      rowId: bundleRowKey('b1'),
      intent: 'bundle',
    });
    expect(order(p.moves, 'h')).toEqual(['doc', 'd1', 'd2', 'rent', 'gym']);
    expect(p.bundleOp).toEqual({
      kind: 'join',
      categoryIds: ['rent'],
      bundleId: 'b1',
    });
  });
  test('center on own bundle is a no-op', () => {
    expect(planDrop(cats, 'd1', { rowId: 'd2', intent: 'bundle' }).bundleOp.kind).toBe('none');
  });
  test('edge drop above a bundle row leaves its bundle and lands before the first child', () => {
    const p = planDrop(cats, 'gym', {
      rowId: bundleRowKey('b1'),
      intent: 'before',
    });
    expect(order(p.moves, 'h')).toEqual(['doc', 'gym', 'd1', 'd2']);
    expect(p.bundleOp.kind).toBe('none');
    const q = planDrop(cats, 'd1', { rowId: 'gym', intent: 'after' });
    expect(order(q.moves, 'h')).toEqual(['doc', 'd2', 'gym', 'd1']);
    expect(q.bundleOp).toEqual({ kind: 'leave', categoryIds: ['d1'] });
  });
  test('edge drop between children joins the bundle at that slot', () => {
    const p = planDrop(cats, 'gym', { rowId: 'd1', intent: 'after' });
    expect(order(p.moves, 'h')).toEqual(['doc', 'd1', 'gym', 'd2']);
    expect(p.bundleOp).toEqual({
      kind: 'join',
      categoryIds: ['gym'],
      bundleId: 'b1',
    });
  });
  test('plain edge drop keeps the old reorder behaviour', () => {
    const p = planDrop(cats, 'food', { rowId: 'rent', intent: 'before' });
    expect(order(p.moves, 'f')).toEqual(['food', 'rent']);
    expect(p.bundleOp.kind).toBe('none');
  });
});

describe('planCreate / planJoin', () => {
  test('selection gathers at the first selected row', () => {
    const p = planCreate(cats, ['gym', 'doc'], 'h');
    expect(order(p.moves, 'h')).toEqual(['doc', 'gym', 'd1', 'd2']);
    expect(p.bundleOp).toEqual({
      kind: 'create',
      categoryIds: ['doc', 'gym'],
      groupId: 'h',
    });
  });
  test('cross-group selection moves the others into the group', () => {
    const p = planCreate(cats, ['doc', 'rent'], 'h');
    expect(order(p.moves, 'h')).toEqual(['doc', 'rent', 'd1', 'd2', 'gym']);
    expect(order(p.moves, 'f')).toEqual(['food']);
  });
  test('join appends after the last child', () => {
    const p = planJoin(cats, ['gym'], 'b1');
    expect(order(p.moves, 'h')).toEqual(['doc', 'd1', 'd2', 'gym']);
  });
});
