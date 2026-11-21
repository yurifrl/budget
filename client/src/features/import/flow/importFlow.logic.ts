/**
 * Pure state and view-model of the import-transactions page: the flow
 * reducer (pick → mapping → preview), the review-table pagination, the payee
 * association pools and the summary strings. Reads payee wire rows and the
 * import module's types, so it lives beside the screen rather than in domain/.
 */

import type { PayeeAdminRow } from '@/budget/data/rows';
import {
  assocRules,
  emptyMapping,
  parseCsv,
  type CsvMapping,
  type DraftImportRow,
  type ImportParseResult,
} from '../parsers';
import { t } from '../i18n';

/** Review rows per page — a full statement at once is unusable on web. */
export const PAGE_SIZE = 25;

export type ImportStage = 'pick' | 'mapping' | 'preview';

export interface ImportOutcome {
  imported: number;
  duplicates: number;
}

export interface ImportFlowState {
  fileName: string | null;
  stage: ImportStage;
  /** The picked file's text, kept for the live re-parse of the column mapper. */
  rawText: string | null;
  mapping: CsvMapping;
  mappingNote: string | null;
  /** The editable review rows; null until a file parsed into rows. */
  drafts: DraftImportRow[] | null;
  page: number;
  imported: ImportOutcome | null;
  /** Import succeeded but saving the payee rename rules failed. */
  rulesError: string | null;
  error: string | null;
}

export function initialImportFlow(): ImportFlowState {
  return {
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
  };
}

export type ImportFlowAction =
  /** "Choose file…" pressed: stale messages go before the picker opens. */
  | { type: 'pickStarted' }
  /** A file was picked and read (an empty text is kept as null). */
  | { type: 'fileRead'; name: string; text: string }
  /** Unknown layout → the column mapper, starting from `mapping`. */
  | { type: 'mappingNeeded'; mapping: CsvMapping; note: string | null }
  /** The parser produced no rows: back to pick with its rejection. */
  | { type: 'fileRejected'; error: string }
  /** Picking/reading threw: forget the file entirely. */
  | { type: 'pickFailed'; error: string }
  /** Rows parsed (recognised layout, or the confirmed mapping): review them. */
  | { type: 'rowsReady'; drafts: DraftImportRow[] }
  | { type: 'mappingChanged'; mapping: CsvMapping }
  /** Reset the review table so another file can be imported. */
  | { type: 'reviewReset' }
  | { type: 'draftPatched'; index: number; patch: Partial<DraftImportRow> }
  /** Select all / Deselect all. */
  | { type: 'allIncluded'; included: boolean }
  | { type: 'pageSet'; page: number }
  | { type: 'importStarted' }
  | { type: 'imported'; outcome: ImportOutcome }
  | { type: 'rulesFailed'; error: string }
  | { type: 'importFailed'; error: string };

export function importFlowReducer(state: ImportFlowState, action: ImportFlowAction): ImportFlowState {
  switch (action.type) {
    case 'pickStarted':
      return { ...state, error: null, imported: null, rulesError: null };
    case 'fileRead':
      return { ...state, fileName: action.name, rawText: action.text || null };
    case 'mappingNeeded':
      return { ...state, drafts: null, mapping: action.mapping, mappingNote: action.note, stage: 'mapping' };
    case 'fileRejected':
      return { ...state, drafts: null, stage: 'pick', error: action.error };
    case 'pickFailed':
      return { ...state, fileName: null, rawText: null, drafts: null, stage: 'pick', error: action.error };
    case 'rowsReady':
      return { ...state, drafts: action.drafts, stage: 'preview', page: 0 };
    case 'mappingChanged':
      return { ...state, mapping: action.mapping };
    case 'reviewReset':
      // The error banner is not part of the review: it stays as it was.
      return { ...initialImportFlow(), error: state.error };
    case 'draftPatched':
      // No drafts, nothing to patch (a late blur commit after a reset).
      if (!state.drafts) return state;
      return { ...state, drafts: state.drafts.map((d, i) => (i === action.index ? { ...d, ...action.patch } : d)) };
    case 'allIncluded':
      if (!state.drafts) return state;
      return { ...state, drafts: state.drafts.map((d) => ({ ...d, included: action.included })) };
    case 'pageSet':
      return { ...state, page: action.page };
    case 'importStarted':
      return { ...state, error: null };
    case 'imported':
      return { ...state, imported: action.outcome };
    case 'rulesFailed':
      return { ...state, rulesError: action.error };
    case 'importFailed':
      return { ...state, error: action.error };
  }
}

/** How a parsed file continues: the column mapper, a rejection, or the review. */
export function parsedOutcome(result: ImportParseResult): 'unrecognized' | 'empty' | 'rows' {
  if (result.errors.length === 1 && result.errors[0].startsWith('unrecognized file layout')) return 'unrecognized';
  return result.rows.length === 0 ? 'empty' : 'rows';
}

/** Payees offered for association: hidden payees vanish from pickers; deleted rows are inert history. */
export function visiblePayees(payees: readonly PayeeAdminRow[]): PayeeAdminRow[] {
  return payees.filter((p) => !p.deleted && !p.hidden);
}

/** The per-row association dropdown: visible payees by name. */
export function payeeOptions(payees: readonly PayeeAdminRow[]): { key: string; label: string }[] {
  return visiblePayees(payees)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ key: p.id, label: p.name }));
}

/** Every payee (hidden and deleted too) by id, to resolve a row's association. */
export function payeesById(payees: readonly PayeeAdminRow[]): Map<string, PayeeAdminRow> {
  const byId = new Map<string, PayeeAdminRow>();
  for (const p of payees) byId.set(p.id, p);
  return byId;
}

/**
 * Pending associations: statement text → chosen payee name, i.e. what will be
 * saved as rename rules (conflicts are dropped by assocRules, and payees that
 * already carry a different rule keep their saved rule).
 */
export function pendingRules(drafts: readonly DraftImportRow[] | null, byId: ReadonlyMap<string, PayeeAdminRow>) {
  if (!drafts) return [];
  return assocRules(drafts, byId).filter((rule) => {
    const current = byId.get(rule.payeeId)?.rename_condition;
    return current == null || current === rule.condition;
  });
}

/** What the payee cell shows: the associated payee's name, else the row's text. */
export function payeeDisplay(row: Pick<DraftImportRow, 'payee' | 'payeeId'>, byId: ReadonlyMap<string, PayeeAdminRow>): string {
  return row.payeeId != null ? (byId.get(row.payeeId)?.name ?? row.payee) : row.payee;
}

/** Included rows shaped for the wire mapper: an association overrides the statement text. */
export function rowsToImport(drafts: readonly DraftImportRow[], byId: ReadonlyMap<string, PayeeAdminRow>) {
  return drafts
    .filter((d) => d.included)
    .map((row) => ({
      ...row,
      resolvedPayee: row.payeeId != null ? byId.get(row.payeeId)?.name : undefined,
    }));
}

export interface ReviewPage {
  pageCount: number;
  /** `page` clamped to the last page (the table can shrink under it). */
  safePage: number;
  /** Index into the drafts of the page's first row. */
  offset: number;
  rows: DraftImportRow[];
}

/** The review table's current page. */
export function reviewPage(drafts: readonly DraftImportRow[] | null, page: number, pageSize = PAGE_SIZE): ReviewPage {
  const pageCount = drafts ? Math.max(1, Math.ceil(drafts.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  return {
    pageCount,
    safePage,
    offset: safePage * pageSize,
    rows: (drafts ?? []).slice(safePage * pageSize, (safePage + 1) * pageSize),
  };
}

/** Column count of the (suspected) header row; drives the mapper dropdowns. */
export function headerColumnCount(rawText: string | null, mapping: Pick<CsvMapping, 'delimiter' | 'headerRow'>): number {
  if (!rawText) return 0;
  const rows = parseCsv(rawText, mapping.delimiter);
  return rows[mapping.headerRow]?.length ?? 0;
}

/** Mapper dropdown: "(not imported)" then one entry per file column. */
export function columnOptions(columnCount: number): { key: string; label: string }[] {
  return [
    { key: '-1', label: t('mapping.notImported') },
    ...Array.from({ length: columnCount }, (_, i) => ({ key: String(i), label: t('mapping.column', { n: i + 1 }) })),
  ];
}

/** Mapper dropdown value: blank only for a cleared (null) role. */
export function columnLabel(column: number | null | undefined): string {
  return column == null ? '' : t('mapping.column', { n: column + 1 });
}

/** The mapping value a dropdown pick stores: "(not imported)" clears the role. */
export function pickedColumn(key: string): number | null {
  return key === '-1' ? null : Number(key);
}

/** "12 transactions, 2 skipped" under the column mapper. */
export function mappedSummary(mapped: Pick<ImportParseResult, 'rows' | 'skipped'>): string {
  const count = mapped.rows.length;
  return mapped.skipped > 0 ? t('mapping.summarySkipped', { count, skipped: mapped.skipped }) : t('mapping.summary', { count });
}

/** "3 of 5 transactions selected, 2 excluded" above the review table. */
export function selectionSummary(included: number, total: number): string {
  return total - included > 0
    ? t('review.selectionExcluded', { included, count: total, excluded: total - included })
    : t('review.selection', { included, count: total });
}

/** Heading of the pending-associations note. */
export function rulesHeading(count: number): string {
  return t('rules.heading', { count });
}

/** The success line after an import. */
export function importedSummary(outcome: ImportOutcome, ruleCount: number): string {
  return (
    t('review.imported', { count: outcome.imported }) +
    (outcome.duplicates > 0 ? t('review.importedDuplicates', { count: outcome.duplicates }) : '') +
    (ruleCount > 0 ? t('review.importedRules', { count: ruleCount }) : '')
  );
}

export function importButtonLabel(included: number): string {
  return t('review.importButton', { count: included });
}
