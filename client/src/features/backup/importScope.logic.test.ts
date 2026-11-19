import { describe, expect, test } from 'bun:test';

import {
  countUnmatchedCategories,
  dependencyNote,
  scopedPayload,
  sectionCountsText,
  toggleSection,
  wireSections,
} from './importScope.logic';
import type { TransferPayload } from './transfer/payload';

const payload: TransferPayload = {
  groups: ['Everyday'],
  categories: [
    { groupIndex: 0, name: 'Groceries' },
    { groupIndex: 0, name: 'Rent' },
  ],
  accounts: [{ name: 'Checking' }],
  transactions: [
    { accountIndex: 0, date: '2026-01-01', payee: 'A', categoryIndex: 0, memo: '', outflow: 1, inflow: 0, cleared: 'cleared', flag: '', transferPeerIndex: null },
    { accountIndex: 0, date: '2026-01-02', payee: 'B', categoryIndex: 1, memo: '', outflow: 1, inflow: 0, cleared: 'cleared', flag: '', transferPeerIndex: null },
    { accountIndex: 0, date: '2026-01-03', payee: 'C', categoryIndex: null, memo: '', outflow: 1, inflow: 0, cleared: 'cleared', flag: '', transferPeerIndex: null },
  ],
  assignments: [{ categoryIndex: 0, month: '2026-01-01', budgeted: 100 }],
};

describe('importScope', () => {
  test('section counts text', () => {
    expect(sectionCountsText(payload, 'plan')).toBe('1 group, 2 categories, 1 assignment');
    expect(sectionCountsText(payload, 'register')).toBe('1 account, 3 transactions');
  });

  test('toggle only within what the backup has, kept in plan/register order', () => {
    expect(toggleSection(['plan'], 'register', ['plan', 'register'])).toEqual(['plan', 'register']);
    expect(toggleSection(['plan', 'register'], 'plan', ['plan', 'register'])).toEqual(['register']);
    expect(toggleSection(['plan'], 'register', ['plan'])).toEqual(['plan']);
  });

  test('wire sections: both = omitted (old contract), one = explicit', () => {
    expect(wireSections(['plan', 'register'])).toBeUndefined();
    expect(wireSections(['register'])).toEqual(['register']);
    expect(wireSections(['plan'])).toEqual(['plan']);
  });

  test('scoped payload drops the unused side but keeps categories for matching', () => {
    const planOnly = scopedPayload(payload, ['plan']);
    expect(planOnly.accounts).toEqual([]);
    expect(planOnly.transactions).toEqual([]);
    expect(planOnly.assignments).toHaveLength(1);
    const registerOnly = scopedPayload(payload, ['register']);
    expect(registerOnly.assignments).toEqual([]);
    expect(registerOnly.transactions).toHaveLength(3);
    expect(registerOnly.categories).toHaveLength(2);
  });

  test('dependency note only for a partial restore', () => {
    expect(dependencyNote(['plan', 'register'])).toBeNull();
    expect(dependencyNote(['plan'])).toContain('re-linked');
    expect(dependencyNote(['register'])).toContain('matched');
  });

  test('unmatched categories counted per transaction', () => {
    expect(countUnmatchedCategories(payload, [{ group: 'everyday', name: 'groceries' }])).toBe(1);
    expect(countUnmatchedCategories(payload, [])).toBe(2);
  });
});
