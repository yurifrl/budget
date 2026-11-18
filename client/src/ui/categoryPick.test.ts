import { describe, expect, test } from 'bun:test';

import { buildCategoryPickItems, matchesCategoryQuery } from './categoryPick';
import type { Bundle, Category, CategoryGroup } from '@/domain/types';

const groups = [{ id: 'g', name: 'Health' }] as unknown as CategoryGroup[];
const bundles: Bundle[] = [{ id: 'b', groupId: 'g', name: 'Medicines' }];
const categories = [
  { id: '1', name: 'Dipirona', groupId: 'g', bundleId: 'b' },
  { id: '2', name: 'Gym', groupId: 'g' },
] as unknown as Category[];

const build = (query: string, extra = {}) =>
  buildCategoryPickItems({ categories, groups, bundles, query, excludeId: null, selectedId: undefined, ...extra });

describe('categoryPick with bundles', () => {
  test('labels bundled categories "Bundle › Category"', () => {
    expect(build('').map((i) => i.label)).toEqual(['Medicines › Dipirona', 'Gym']);
  });

  test('search matches the bundle name or the category name', () => {
    expect(build('medic').map((i) => i.categoryId)).toEqual(['1']);
    expect(build('dipi').map((i) => i.categoryId)).toEqual(['1']);
    expect(build('gym').map((i) => i.categoryId)).toEqual(['2']);
    expect(build('zzz')).toEqual([]);
  });

  test('pinned selected row carries the bundle label', () => {
    expect(build('', { selectedId: '1', pinSelected: true })[0].label).toBe('Medicines › Dipirona');
  });

  test('matchesCategoryQuery: empty query matches, no bundles falls back to name', () => {
    expect(matchesCategoryQuery(categories[1], [], '')).toBe(true);
    expect(matchesCategoryQuery(categories[0], [], 'medic')).toBe(false);
  });
});
