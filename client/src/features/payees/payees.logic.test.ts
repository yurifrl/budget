import { describe, expect, test } from 'bun:test';

import type { PayeeAdminRow } from '@/budget/data/rows';
import {
  activityLine,
  filterPayees,
  matchTypeFromLabel,
  mergeCandidatesFor,
  pageCount,
  renameToCommit,
  ruleToSave,
  savedRule,
} from './payees.logic';

const payee = (over: Partial<PayeeAdminRow> = {}): PayeeAdminRow => ({
  id: 'p1',
  name: 'Padaria',
  transfer_account_id: null,
  deleted: false,
  hidden: false,
  categorization_mode: 'auto',
  default_category_id: null,
  rename_match_type: null,
  rename_condition: null,
  transaction_count: 0,
  last_used_date: null,
  inferred_category_id: null,
  inferred_category_name: null,
  ...over,
});

describe('filterPayees', () => {
  const all = [payee({ id: 'a', name: 'Padaria Real' }), payee({ id: 'b', name: 'Uber', hidden: true }), payee({ id: 'c', name: 'iFood' })];

  test('blank search keeps everything, in order, hidden included', () => {
    expect(filterPayees(all, '').map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(filterPayees(all, '   ').map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  test('matches a substring case-insensitively and trims the query', () => {
    expect(filterPayees(all, '  REAL ').map((p) => p.id)).toEqual(['a']);
    expect(filterPayees(all, 'ub').map((p) => p.id)).toEqual(['b']);
    expect(filterPayees(all, 'zzz')).toEqual([]);
  });
});

describe('mergeCandidatesFor', () => {
  const sel = payee({ id: 'a' });
  const all = [
    sel,
    payee({ id: 'b' }),
    payee({ id: 'c', deleted: true }),
    payee({ id: 'd', transfer_account_id: 'acc1' }),
    payee({ id: 'e', hidden: true }),
  ];

  test('other live non-transfer payees; hidden ones are still targets', () => {
    expect(mergeCandidatesFor(all, sel).map((p) => p.id)).toEqual(['b', 'e']);
  });

  test('no selection, no candidates', () => {
    expect(mergeCandidatesFor(all, null)).toEqual([]);
  });
});

describe('savedRule / ruleToSave', () => {
  const bare = payee();
  const ruled = payee({ rename_match_type: 'is', rename_condition: 'UBER *TRIP' });

  test('no stored rule reads as an empty Contains', () => {
    expect(savedRule(bare)).toEqual({ matchType: 'contains', condition: '' });
    expect(savedRule(ruled)).toEqual({ matchType: 'is', condition: 'UBER *TRIP' });
  });

  test('nothing to save without a draft or patch', () => {
    expect(ruleToSave(null, bare)).toBeNull();
    expect(ruleToSave(null, ruled)).toBeNull();
  });

  test('a draft equal to the saved rule after trimming is a no-op', () => {
    expect(ruleToSave({ matchType: 'is', condition: '  UBER *TRIP ' }, ruled)).toBeNull();
    expect(ruleToSave({ matchType: 'contains', condition: '   ' }, bare)).toBeNull();
  });

  test('a changed condition is sent trimmed with the draft matcher', () => {
    expect(ruleToSave({ matchType: 'contains', condition: ' padaria ' }, bare)).toEqual({ matchType: 'contains', condition: 'padaria' });
  });

  test('an emptied condition is sent (clears the rule)', () => {
    expect(ruleToSave({ matchType: 'is', condition: '' }, ruled)).toEqual({ matchType: 'is', condition: '' });
  });

  test('a matcher patch overlays the draft, else the saved rule', () => {
    expect(ruleToSave(null, ruled, { matchType: 'contains' })).toEqual({ matchType: 'contains', condition: 'UBER *TRIP' });
    expect(ruleToSave({ matchType: 'is', condition: 'x' }, ruled, { matchType: 'contains' })).toEqual({ matchType: 'contains', condition: 'x' });
    // Patching the matcher back to the saved one with an unchanged condition is a no-op.
    expect(ruleToSave(null, ruled, { matchType: 'is' })).toBeNull();
    // No stored rule: switching to Is with an empty condition still differs from the Contains default.
    expect(ruleToSave(null, bare, { matchType: 'is' })).toEqual({ matchType: 'is', condition: '' });
  });
});

describe('renameToCommit', () => {
  test('untouched, blank or unchanged names commit nothing', () => {
    expect(renameToCommit(null, 'Uber')).toBeNull();
    expect(renameToCommit('   ', 'Uber')).toBeNull();
    expect(renameToCommit(' Uber ', 'Uber')).toBeNull();
  });

  test('a new name is trimmed; case changes count', () => {
    expect(renameToCommit('  Uber Eats ', 'Uber')).toBe('Uber Eats');
    expect(renameToCommit('uber', 'Uber')).toBe('uber');
  });
});

describe('matchTypeFromLabel', () => {
  test('adopts an exact label, case-insensitive and trimmed', () => {
    expect(matchTypeFromLabel('Contains')).toBe('contains');
    expect(matchTypeFromLabel(' is ')).toBe('is');
    expect(matchTypeFromLabel('IS')).toBe('is');
  });

  test('anything else is not a matcher', () => {
    expect(matchTypeFromLabel('Cont')).toBeUndefined();
    expect(matchTypeFromLabel('')).toBeUndefined();
  });
});

describe('activityLine', () => {
  test('pluralises and shows the last-used day only', () => {
    expect(activityLine({ transaction_count: 1, last_used_date: '2026-03-04T10:00:00Z' })).toBe('1 transaction · last used 2026-03-04');
    expect(activityLine({ transaction_count: 12, last_used_date: '2026-03-04' })).toBe('12 transactions · last used 2026-03-04');
    expect(activityLine({ transaction_count: 0, last_used_date: null })).toBe('0 transactions · never used');
  });
});

describe('pageCount', () => {
  test('at least one page; partial pages round up', () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(125, 25)).toBe(5);
  });
});
