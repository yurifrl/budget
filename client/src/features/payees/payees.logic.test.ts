import { describe, expect, test } from 'bun:test';

import type { PayeeAdminRow } from '@/budget/data/rows';
import { activityLine, mergeCandidatesFor, pageCount, renameToCommit } from './payees.logic';

const payee = (over: Partial<PayeeAdminRow> = {}): PayeeAdminRow => ({
  id: 'p1',
  name: 'Padaria',
  transfer_account_id: null,
  transfer_rule: null,
  transfer_rule_account_id: null,
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
