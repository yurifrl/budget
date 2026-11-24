/**
 * Contabilizei statement source — the PJ bank account's CSV export
 * (`<account>_<DDMMMYYYY>_<DDMMMYYYY>.csv`), zero-config. The file has no
 * provider id column, so rows carry a deterministic YNAB-fallback id
 * (`contabilizei:<date>:<signedMilli>:<n>` — date + amount + ordinal)
 * and the bulk endpoint dedupes re-imports on it like any other source.
 */

import { parseCsv, sniffDelimiter } from '../util/csv';
import { parseImportDate } from '../util/date';
import { parseImportAmount } from '../util/money';
import type { ImportParseResult, ImportRow } from '@/domain/importTypes';

/** A parsed row that also carries the dedupe key used by the bulk endpoint. */
export interface ContabilizeiRow extends ImportRow {
  /** Deterministic dedupe id — derived, never read from the file. */
  importId: string;
}

export interface ContabilizeiParseResult extends ImportParseResult {
  rows: ContabilizeiRow[];
}

const has = (cells: string[], re: RegExp): boolean => cells.some((c) => re.test(c.trim()));
const idxOf = (cells: string[], re: RegExp): number => cells.findIndex((c) => re.test(c.trim()));
const cell = (cells: string[], idx: number): string => (idx >= 0 && idx < cells.length ? cells[idx] : '');

/**
 * Contabilizei's header: `Saldo do dia` next to the Lançamento + Descrição
 * pair is what makes the layout distinct (a plain `Descrição` column alone
 * looks like a Nubank conta export).
 */
const isHeader = (cells: string[]): boolean =>
  has(cells, /^data$/i) &&
  has(cells, /^lançamento$/i) &&
  has(cells, /^descri/i) &&
  has(cells, /^entrada$/i) &&
  has(cells, /^saída$/i) &&
  has(cells, /^saldo do dia$/i);

/** Detect the Contabilizei CSV from the header row; `has` trims the UTF-8 BOM off the first cell. */
export function detectContabilizeiCsv(text: string): boolean {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const raw = parseCsv(text, sniffDelimiter(firstLine));
  return raw.findIndex(isHeader) !== -1;
}

/**
 * Parse a Contabilizei export: payee ← `Descrição` (counterparty), memo ←
 * `Lançamento` (PIX / Pagamento / Outros), amounts ← `Entrada` / `Saída`
 * (pt-BR "R$ 1.314,51"; a bare `-` or empty cell means 0). `Saldo do dia` is
 * a per-day figure and is not imported.
 */
export function parseContabilizeiCsv(text: string): ContabilizeiParseResult {
  const rows: ContabilizeiRow[] = [];
  const errors: string[] = [];
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const raw = parseCsv(text, sniffDelimiter(firstLine));
  if (raw.length === 0) return { rows, skipped: 0, errors: ['empty file'] };

  const headerIdx = raw.findIndex(isHeader);
  if (headerIdx === -1) return { rows, skipped: 0, errors: ['not a Contabilizei statement'] };
  const header = raw[headerIdx];
  const dateCol = idxOf(header, /^data$/i);
  const typeCol = idxOf(header, /^lançamento$/i);
  const payeeCol = idxOf(header, /^descri/i);
  const inflowCol = idxOf(header, /^entrada$/i);
  const outflowCol = idxOf(header, /^saída$/i);

  // Occurrence count per (date, signed amount): the ordinal keeps ids
  // unique for same-day equal-amount rows whatever the payee, and the
  // payee appears nowhere in the id, so renaming it never changes the id.
  const occurrence = new Map<string, number>();

  for (let i = headerIdx + 1; i < raw.length; i++) {
    const cells = raw[i];
    const line = i + 1;
    const date = parseImportDate(cell(cells, dateCol));
    if (!date) {
      errors.push(`line ${line}: bad date`);
      continue;
    }
    const inflow = parseSide(cell(cells, inflowCol));
    const outflow = parseSide(cell(cells, outflowCol));
    // Both sides empty/`-` (or unreadable), or both sides set: no single
    // readable side.
    if (inflow == null || outflow == null || (inflow === 0) === (outflow === 0)) {
      errors.push(`line ${line}: no readable amount`);
      continue;
    }
    const payee = cell(cells, payeeCol).trim();
    const signedMilli = (inflow - outflow) * 10;
    // Key WITHOUT the payee: two same-day rows with the same amount but
    // different payees must still get :1 and :2, or their identical ids
    // would make the server's dedupe silently drop the second row.
    const key = `${date}:${signedMilli}`;
    const n = (occurrence.get(key) ?? 0) + 1;
    occurrence.set(key, n);
    rows.push({
      date,
      payee,
      memo: cell(cells, typeCol).trim(),
      outflowCents: outflow,
      inflowCents: inflow,
      importId: `contabilizei:${date}:${signedMilli}:${n}`,
    });
  }
  const consumed = headerIdx + 1 + rows.length + errors.length;
  return { rows, skipped: Math.max(0, raw.length - consumed), errors };
}

/** `Entrada`/`Saída` cell → cents; a bare `-` or empty cell means 0. */
function parseSide(input: string): number | null {
  const s = input.trim();
  if (s === '' || s === '-') return 0;
  return parseImportAmount(s);
}
