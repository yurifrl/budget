import { describe, expect, test } from 'bun:test';

import type { PayeeAdminRow } from '../../data/rows';
import { emptyMapping, type DraftImportRow } from '../../import';
import {
  columnLabel,
  columnOptions,
  headerColumnCount,
  importButtonLabel,
  importedSummary,
  importFlowReducer,
  initialImportFlow,
  mappedSummary,
  PAGE_SIZE,
  parsedOutcome,
  payeeDisplay,
  payeeOptions,
  payeesById,
  pendingRules,
  pickedColumn,
  reviewPage,
  rowsToImport,
  rulesHeading,
  selectionSummary,
  visiblePayees,
  type ImportFlowState,
} from './importFlow.logic';

const payee = (over: Partial<PayeeAdminRow>): PayeeAdminRow => ({
  id: 'p',
  name: 'P',
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

const draft = (over: Partial<DraftImportRow> = {}): DraftImportRow => ({
  date: '2026-01-02',
  payee: 'UBER *TRIP',
  memo: '',
  outflowCents: 1000,
  inflowCents: 0,
  originalPayee: 'UBER *TRIP',
  payeeId: null,
  included: true,
  ...over,
});

const drafts = (n: number) => Array.from({ length: n }, (_, i) => draft({ memo: `row ${i}` }));

describe('importFlowReducer', () => {
  const start = initialImportFlow();
  const reviewing: ImportFlowState = { ...start, fileName: 'a.csv', rawText: 'x', stage: 'preview', drafts: drafts(3), page: 2 };

  test('initial state: pick stage, empty mapping, nothing loaded', () => {
    expect(start).toEqual({
      fileName: null,
      stage: 'pick',
      rawText: null,
      mapping: emptyMapping(),
      mappingNote: null,
      drafts: null,
      page: 0,
      imported: null,
      rulesError: null,
      error: null,
    });
  });

  test('pickStarted clears only the messages', () => {
    const dirty = { ...reviewing, error: 'e', rulesError: 'r', imported: { imported: 1, duplicates: 0 } };
    expect(importFlowReducer(dirty, { type: 'pickStarted' })).toEqual({ ...reviewing, error: null, rulesError: null, imported: null });
  });

  test('fileRead keeps the name; an empty text (native XLS) is null', () => {
    expect(importFlowReducer(start, { type: 'fileRead', name: 'a.csv', text: 'a;b' })).toMatchObject({ fileName: 'a.csv', rawText: 'a;b' });
    expect(importFlowReducer(start, { type: 'fileRead', name: 'a.xls', text: '' })).toMatchObject({ fileName: 'a.xls', rawText: null });
  });

  test('mappingNeeded opens the mapper and drops earlier drafts, keeping the page', () => {
    const mapping = emptyMapping(';');
    const next = importFlowReducer(reviewing, { type: 'mappingNeeded', mapping, note: 'n' });
    expect(next).toEqual({ ...reviewing, drafts: null, mapping, mappingNote: 'n', stage: 'mapping' });
  });

  test('fileRejected returns to pick with the error but keeps the file name and text', () => {
    expect(importFlowReducer(reviewing, { type: 'fileRejected', error: 'bad' })).toEqual({ ...reviewing, drafts: null, stage: 'pick', error: 'bad' });
  });

  test('pickFailed forgets the file', () => {
    expect(importFlowReducer(reviewing, { type: 'pickFailed', error: 'boom' })).toEqual({
      ...reviewing,
      fileName: null,
      rawText: null,
      drafts: null,
      stage: 'pick',
      error: 'boom',
    });
  });

  test('rowsReady shows the review from page 0', () => {
    const rows = drafts(2);
    expect(importFlowReducer({ ...start, page: 4, stage: 'mapping' }, { type: 'rowsReady', drafts: rows })).toMatchObject({
      drafts: rows,
      stage: 'preview',
      page: 0,
    });
  });

  test('mappingChanged replaces the mapping only', () => {
    const mapping = { ...emptyMapping(), chargePositive: true };
    expect(importFlowReducer(reviewing, { type: 'mappingChanged', mapping })).toEqual({ ...reviewing, mapping });
  });

  test('reviewReset returns to a fresh pick but leaves the error banner', () => {
    const dirty = { ...reviewing, error: 'e', rulesError: 'r', imported: { imported: 1, duplicates: 0 }, mappingNote: 'n' };
    expect(importFlowReducer(dirty, { type: 'reviewReset' })).toEqual({ ...start, error: 'e' });
  });

  test('draftPatched merges into one row and keeps the others by identity', () => {
    const next = importFlowReducer(reviewing, { type: 'draftPatched', index: 1, patch: { memo: 'edited', included: false } });
    expect(next.drafts?.[1]).toEqual({ ...reviewing.drafts![1], memo: 'edited', included: false });
    expect(next.drafts?.[0]).toBe(reviewing.drafts![0]);
    expect(next.drafts?.[2]).toBe(reviewing.drafts![2]);
  });

  test('draftPatched with an unknown index or no drafts changes no row', () => {
    expect(importFlowReducer(reviewing, { type: 'draftPatched', index: 9, patch: { memo: 'x' } }).drafts).toEqual(reviewing.drafts);
    expect(importFlowReducer(start, { type: 'draftPatched', index: 0, patch: { memo: 'x' } })).toBe(start);
  });

  test('allIncluded flips every row', () => {
    const off = importFlowReducer(reviewing, { type: 'allIncluded', included: false });
    expect(off.drafts?.map((d) => d.included)).toEqual([false, false, false]);
    expect(importFlowReducer(off, { type: 'allIncluded', included: true }).drafts?.map((d) => d.included)).toEqual([true, true, true]);
    expect(importFlowReducer(start, { type: 'allIncluded', included: true })).toBe(start);
  });

  test('pageSet stores the page as given (reviewPage clamps on read)', () => {
    expect(importFlowReducer(reviewing, { type: 'pageSet', page: 7 }).page).toBe(7);
    expect(importFlowReducer(reviewing, { type: 'pageSet', page: -1 }).page).toBe(-1);
  });

  test('import lifecycle: started clears the error; imported, rulesFailed and importFailed record their result', () => {
    const failed = importFlowReducer(reviewing, { type: 'importFailed', error: 'import failed' });
    expect(failed.error).toBe('import failed');
    expect(importFlowReducer(failed, { type: 'importStarted' }).error).toBeNull();
    const done = importFlowReducer(reviewing, { type: 'imported', outcome: { imported: 3, duplicates: 1 } });
    expect(done.imported).toEqual({ imported: 3, duplicates: 1 });
    expect(done.stage).toBe('preview');
    expect(importFlowReducer(done, { type: 'rulesFailed', error: 'r' })).toEqual({ ...done, rulesError: 'r' });
  });
});

describe('parsedOutcome', () => {
  const row = { date: '2026-01-01', payee: 'x', memo: '', outflowCents: 1, inflowCents: 0 };

  test('a single "unrecognized file layout" error opens the mapper', () => {
    expect(parsedOutcome({ rows: [], skipped: 0, errors: ['unrecognized file layout: no known header'] })).toBe('unrecognized');
  });

  test('any other result without rows is a rejection', () => {
    expect(parsedOutcome({ rows: [], skipped: 0, errors: ['could not read XLS'] })).toBe('empty');
    expect(parsedOutcome({ rows: [], skipped: 3, errors: [] })).toBe('empty');
    expect(parsedOutcome({ rows: [], skipped: 0, errors: ['unrecognized file layout', 'line 2: bad date'] })).toBe('empty');
  });

  test('rows go to review even with line errors', () => {
    expect(parsedOutcome({ rows: [row], skipped: 0, errors: ['line 7: bad date'] })).toBe('rows');
  });
});

describe('payee pools', () => {
  const all = [
    payee({ id: 'z', name: 'Zara' }),
    payee({ id: 'h', name: 'Hidden', hidden: true }),
    payee({ id: 'd', name: 'Deleted', deleted: true }),
    payee({ id: 'a', name: 'Amazon' }),
  ];

  test('visiblePayees drops hidden and deleted, keeping order', () => {
    expect(visiblePayees(all).map((p) => p.id)).toEqual(['z', 'a']);
  });

  test('payeeOptions sorts the visible ones by name without touching the input', () => {
    expect(payeeOptions(all)).toEqual([
      { key: 'a', label: 'Amazon' },
      { key: 'z', label: 'Zara' },
    ]);
    expect(all.map((p) => p.id)).toEqual(['z', 'h', 'd', 'a']);
  });

  test('payeesById indexes every payee, hidden and deleted included', () => {
    expect([...payeesById(all).keys()]).toEqual(['z', 'h', 'd', 'a']);
  });

  test('payeeDisplay: the association wins; an unknown id falls back to the row text', () => {
    const byId = payeesById(all);
    expect(payeeDisplay(draft({ payeeId: 'a' }), byId)).toBe('Amazon');
    expect(payeeDisplay(draft({ payeeId: 'gone' }), byId)).toBe('UBER *TRIP');
    expect(payeeDisplay(draft({ payee: 'typed' }), byId)).toBe('typed');
  });
});

describe('pendingRules', () => {
  const uber = payee({ id: 'u', name: 'Uber' });

  test('no drafts, no rules', () => {
    expect(pendingRules(null, payeesById([uber]))).toEqual([]);
  });

  test('an associated row becomes a rule from its statement text', () => {
    expect(pendingRules([draft({ payeeId: 'u' })], payeesById([uber]))).toEqual([
      { payeeId: 'u', condition: 'UBER *TRIP', replacement: 'Uber' },
    ]);
  });

  test('a payee that already has a different rule keeps it; the same rule is re-listed', () => {
    const other = payee({ id: 'u', name: 'Uber', rename_condition: 'UBER BR' });
    expect(pendingRules([draft({ payeeId: 'u' })], payeesById([other]))).toEqual([]);
    const same = payee({ id: 'u', name: 'Uber', rename_condition: 'UBER *TRIP' });
    expect(pendingRules([draft({ payeeId: 'u' })], payeesById([same]))).toHaveLength(1);
  });

  test('excluded rows carry no rule', () => {
    expect(pendingRules([draft({ payeeId: 'u', included: false })], payeesById([uber]))).toEqual([]);
  });
});

describe('rowsToImport', () => {
  test('included rows only; an association resolves the payee name, otherwise undefined', () => {
    const byId = payeesById([payee({ id: 'u', name: 'Uber' })]);
    const rows = [draft({ payeeId: 'u' }), draft({ included: false }), draft({ payee: 'typed' }), draft({ payeeId: 'gone' })];
    const out = rowsToImport(rows, byId);
    expect(out.map((r) => r.resolvedPayee)).toEqual(['Uber', undefined, undefined]);
    expect(out[1].payee).toBe('typed');
    expect(out[0].originalPayee).toBe('UBER *TRIP');
  });
});

describe('reviewPage', () => {
  test('no drafts: one empty page', () => {
    expect(reviewPage(null, 0)).toEqual({ pageCount: 1, safePage: 0, offset: 0, rows: [] });
    expect(reviewPage([], 0)).toEqual({ pageCount: 1, safePage: 0, offset: 0, rows: [] });
  });

  test('slices PAGE_SIZE rows and reports the offset of the first', () => {
    const rows = drafts(PAGE_SIZE * 2 + 3);
    const second = reviewPage(rows, 1);
    expect(second.pageCount).toBe(3);
    expect(second.offset).toBe(PAGE_SIZE);
    expect(second.rows).toHaveLength(PAGE_SIZE);
    expect(second.rows[0]).toBe(rows[PAGE_SIZE]);
    expect(reviewPage(rows, 2).rows).toHaveLength(3);
  });

  test('a page past the end clamps to the last page', () => {
    const rows = drafts(PAGE_SIZE + 1);
    expect(reviewPage(rows, 9)).toMatchObject({ pageCount: 2, safePage: 1, offset: PAGE_SIZE });
    expect(reviewPage(rows, 9).rows).toHaveLength(1);
  });

  test('a page below zero is NOT clamped: it reads as an empty page -1 (current behaviour)', () => {
    const rows = drafts(PAGE_SIZE + 1);
    expect(reviewPage(rows, -1)).toEqual({ pageCount: 2, safePage: -1, offset: -PAGE_SIZE, rows: [] });
  });
});

describe('column mapper', () => {
  test('headerColumnCount counts the header row cells for the delimiter', () => {
    expect(headerColumnCount('a;b;c\n1;2;3', { delimiter: ';', headerRow: 0 })).toBe(3);
    expect(headerColumnCount('a;b;c\n1;2;3', { delimiter: ',', headerRow: 0 })).toBe(1);
  });

  test('no text, or no header row (-1), counts zero', () => {
    expect(headerColumnCount(null, { delimiter: ',', headerRow: 0 })).toBe(0);
    expect(headerColumnCount('a,b', { delimiter: ',', headerRow: -1 })).toBe(0);
  });

  test('columnOptions: "(not imported)" then 1-based columns', () => {
    expect(columnOptions(2)).toEqual([
      { key: '-1', label: '(not imported)' },
      { key: '0', label: 'Column 1' },
      { key: '1', label: 'Column 2' },
    ]);
    expect(columnOptions(0)).toEqual([{ key: '-1', label: '(not imported)' }]);
  });

  test('columnLabel is 1-based; only null/undefined is blank (the unmapped -1 reads "Column 0", current behaviour)', () => {
    expect(columnLabel(0)).toBe('Column 1');
    expect(columnLabel(4)).toBe('Column 5');
    expect(columnLabel(null)).toBe('');
    expect(columnLabel(undefined)).toBe('');
    expect(columnLabel(-1)).toBe('Column 0');
  });

  test('pickedColumn: "(not imported)" stores null, a column stores its index', () => {
    expect(pickedColumn('-1')).toBeNull();
    expect(pickedColumn('0')).toBe(0);
    expect(pickedColumn('3')).toBe(3);
  });
});

describe('summaries', () => {
  test('mappedSummary', () => {
    expect(mappedSummary({ rows: drafts(1), skipped: 0 })).toBe('1 transaction');
    expect(mappedSummary({ rows: drafts(3), skipped: 2 })).toBe('3 transactions, 2 skipped');
    expect(mappedSummary({ rows: [], skipped: 0 })).toBe('0 transactions');
  });

  test('selectionSummary pluralises on the total', () => {
    expect(selectionSummary(5, 5)).toBe('5 of 5 transactions selected');
    expect(selectionSummary(3, 5)).toBe('3 of 5 transactions selected, 2 excluded');
    expect(selectionSummary(0, 1)).toBe('0 of 1 transaction selected, 1 excluded');
  });

  test('rulesHeading', () => {
    expect(rulesHeading(1)).toBe('1 payee association will be saved as rename rules:');
    expect(rulesHeading(3)).toBe('3 payee associations will be saved as rename rules:');
  });

  test('importedSummary', () => {
    expect(importedSummary({ imported: 1, duplicates: 0 }, 0)).toBe('Imported 1 transaction');
    expect(importedSummary({ imported: 4, duplicates: 1 }, 0)).toBe('Imported 4 transactions, skipped 1 duplicate');
    expect(importedSummary({ imported: 4, duplicates: 2 }, 1)).toBe('Imported 4 transactions, skipped 2 duplicates — 1 payee rule saved');
    expect(importedSummary({ imported: 0, duplicates: 0 }, 2)).toBe('Imported 0 transactions — 2 payee rules saved');
  });

  test('importButtonLabel', () => {
    expect(importButtonLabel(1)).toBe('Import 1 transaction');
    expect(importButtonLabel(0)).toBe('Import 0 transactions');
  });
});
