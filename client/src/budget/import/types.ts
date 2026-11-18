/**
 * Statement-import domain types — pure data, no platform imports. Shared
 * contract between the parsers (util/), the bank sources (sources/), and the
 * import sheet (screens/).
 */

import type { Cents } from '../domain/types';

/** One transaction candidate extracted from a CSV line. */
export interface ImportRow {
  /** Normalized ISO date ("YYYY-MM-DD"), always valid. */
  date: string;
  /** Payee as written in the file (trimmed; may be empty). */
  payee: string;
  /** Memo/note as written in the file (trimmed; may be empty). */
  memo: string;
  /** Money leaving the account, in cents (>= 0). */
  outflowCents: Cents;
  /** Money entering the account, in cents (>= 0). */
  inflowCents: Cents;
}

export interface ImportParseResult {
  rows: ImportRow[];
  /** Lines ignored because they were empty or matched the header. */
  skipped: number;
  /** Human-readable problems per rejected line ("line 7: ..."). */
  errors: string[];
}

/** Column roles a CSV layout can map. */
export type ColumnKey = 'date' | 'payee' | 'memo' | 'outflow' | 'inflow' | 'amount' | 'category';

/** User-confirmed layout for an unrecognized CSV (import sheet mapping step). */
export interface CsvMapping {
  /** Field separator sniffed from the file or chosen by the user. */
  delimiter: string;
  /** Index of the header row; rows before it are skipped. */
  headerRow: number;
  /** 0-based column index per role; -1 = unmapped. */
  columns: Record<ColumnKey, number>;
  /** Positive amounts are charges (credit-card bills). */
  chargePositive: boolean;
}
