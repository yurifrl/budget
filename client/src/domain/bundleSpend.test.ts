import { describe, expect, test } from 'bun:test';

import { filterChips, selectionCategoryIds, spendRows } from './bundleSpend';
import type { Bundle, Category } from './types';

const cat = (id: string, name: string, bundleId?: string) =>
  ({ id, name, bundleId, groupId: 'g' }) as unknown as Category;
const bundles: Bundle[] = [{ id: 'b', groupId: 'g', name: 'Medicines' }];
const cats = [cat('1', 'Dipirona', 'b'), cat('2', 'Rent'), cat('3', 'Aspirina', 'b'), cat('4', 'Idle')];
const totals: Record<string, number> = { '1': 300, '2': 500, '3': 400, '4': 0 };

describe('bundleSpend', () => {
  test('spendRows rolls a bundle into one summed row, sorted, children sorted', () => {
    const rows = spendRows(cats, bundles, (c) => totals[c.id]);
    expect(rows.map((r) => (r.kind === 'bundle' ? r.bundle.name : r.category.name))).toEqual(['Medicines', 'Rent']);
    const b = rows[0];
    expect(b.total).toBe(700);
    expect(b.kind === 'bundle' && b.children.map((c) => c.category.name)).toEqual(['Aspirina', 'Dipirona']);
  });

  test('bundle filter covers all its categories; category filter just one', () => {
    expect([...selectionCategoryIds({ kind: 'bundle', id: 'b' }, cats)].sort()).toEqual(['1', '3']);
    expect([...selectionCategoryIds({ kind: 'category', id: '2' }, cats)]).toEqual(['2']);
  });

  test('filterChips collapses bundled categories into one bundle chip', () => {
    expect(filterChips(cats, bundles).map((c) => c.label)).toEqual(['Medicines', 'Rent', 'Idle']);
  });
});
