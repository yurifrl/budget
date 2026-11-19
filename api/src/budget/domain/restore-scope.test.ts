import { describe, expect, test } from 'bun:test';

import { matchCategoryIds, restoreScope } from './restore-scope';

describe('restoreScope', () => {
  test('absent or empty means everything', () => {
    expect(restoreScope(undefined)).toEqual({ plan: true, register: true });
    expect(restoreScope([])).toEqual({ plan: true, register: true });
  });
  test('single sections', () => {
    expect(restoreScope(['plan'])).toEqual({ plan: true, register: false });
    expect(restoreScope(['register'])).toEqual({ plan: false, register: true });
    expect(restoreScope(['register', 'plan'])).toEqual({ plan: true, register: true });
  });
});

describe('matchCategoryIds', () => {
  const existing = [
    { id: 'a', group_name: 'Everyday', name: 'Groceries' },
    { id: 'b', group_name: 'Bills', name: 'Groceries' },
  ];
  test('matches by group and name, case-insensitively; misses are null', () => {
    const ids = matchCategoryIds(
      ['everyday', 'Bills', 'Other'],
      [
        { groupIndex: 0, name: ' groceries ' },
        { groupIndex: 1, name: 'Groceries' },
        { groupIndex: 2, name: 'Groceries' },
        { groupIndex: 0, name: 'Missing' },
      ],
      existing,
    );
    expect(ids).toEqual(['a', 'b', null, null]);
  });
});
