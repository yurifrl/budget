import { describe, expect, test } from 'bun:test';

import { categoryLabel, dropIntent, planRows } from './bundles';
import type { Bundle } from './types';

const bundles: Bundle[] = [{ id: 'b1', groupId: 'g', name: 'Medicines' }];
const cat = (id: string, bundleId?: string) => ({ id, name: id, bundleId });
const figures = (c: { id: string }) => ({ assigned: c.id.length * 100, activity: -50, available: 10 });

describe('planRows', () => {
  test('plain categories pass through in order', () => {
    const rows = planRows([cat('a'), cat('b')], [], figures);
    expect(rows.map((r) => r.kind)).toEqual(['category', 'category']);
  });

  test('bundle sits at the first child slot; children contiguous; sums add up', () => {
    const rows = planRows([cat('x'), cat('d1', 'b1'), cat('y'), cat('d2', 'b1')], bundles, figures);
    expect(rows.map((r) => (r.kind === 'bundle' ? `bundle:${r.children.map((c) => c.id).join(',')}` : r.category.id))).toEqual([
      'x',
      'bundle:d1,d2',
      'y',
    ]);
    const bundle = rows[1];
    if (bundle.kind !== 'bundle') throw new Error('expected bundle');
    expect(bundle.sums).toEqual({ assigned: 200 + 200, activity: -100, available: 20 });
  });

  test('unknown bundle id falls back to a plain category', () => {
    const rows = planRows([cat('a', 'zzz')], bundles, figures);
    expect(rows).toEqual([{ kind: 'category', category: cat('a', 'zzz') }]);
  });
});

describe('categoryLabel', () => {
  test('bundled and plain', () => {
    expect(categoryLabel(cat('Dipirona', 'b1'), bundles)).toBe('Medicines › Dipirona');
    expect(categoryLabel(cat('Rent'), bundles)).toBe('Rent');
    expect(categoryLabel(cat('Rent', 'missing'), bundles)).toBe('Rent');
  });
});

describe('dropIntent', () => {
  const rect = { top: 100, bottom: 140 };
  test('outer quarters reorder, middle half bundles', () => {
    expect(dropIntent(101, rect)).toBe('before');
    expect(dropIntent(109, rect)).toBe('before');
    expect(dropIntent(110, rect)).toBe('bundle');
    expect(dropIntent(120, rect)).toBe('bundle');
    expect(dropIntent(130, rect)).toBe('bundle');
    expect(dropIntent(131, rect)).toBe('after');
    expect(dropIntent(139, rect)).toBe('after');
  });
});
