/**
 * Contabilizei statement source — the PJ bank account's CSV export
 * (`<account>_<DDMMMYYYY>_<DDMMMYYYY>.csv`), zero-config. The file has no
 * provider id column, so rows go to the server id-less and the bulk
 * endpoint's YNAB fallback key
 * (`YNAB:<milliunits>:<date>:<payeeId>:<occurrence>`, the occurrence counted
 * against the account's existing rows) dedupes re-imports.
 */

import { parseCsv, sniffDelimiter } from '../util/csv';
import { parseImportDate } from '../util/date';
import { parseImportAmount } from '../util/money';
import type { ImportParseResult, ImportRow } from '@/domain/importTypes';

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

/** A side cell carrying no amount: empty string or Contabilizei's bare `-`. */
function isEmptySide(s: string): boolean {
  return s === '' || s === '-';
}

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
export function parseContabilizeiCsv(text: string): ImportParseResult {
  const rows: ImportRow[] = [];
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

  for (let i = headerIdx + 1; i < raw.length; i++) {
    const cells = raw[i];
    const line = i + 1;
    const date = parseImportDate(cell(cells, dateCol));
    if (!date) {
      errors.push(`line ${line}: bad date`);
      continue;
    }
    const inflowCell = cell(cells, inflowCol).trim();
    const outflowCell = cell(cells, outflowCol).trim();
    const inflow = parseSide(inflowCell);
    const outflow = parseSide(outflowCell);
    // Unreadable text, or both sides empty/`-`: no amount at all.
    if (inflow == null || outflow == null || (isEmptySide(inflowCell) && isEmptySide(outflowCell))) {
      errors.push(`line ${line}: no readable amount`);
      continue;
    }
    // Net the two sides: a negative cell reverses its side (a "-R$ 5,00"
    // Saída is money coming back), and no negative cents are ever emitted.
    const signed = inflow - outflow;
    if (signed === 0) {
      // Both sides set and equal, or an explicit 0: nothing to import.
      errors.push(`line ${line}: amount is zero`);
      continue;
    }
    rows.push({
      date,
      payee: cell(cells, payeeCol).trim(),
      memo: cell(cells, typeCol).trim(),
      outflowCents: signed < 0 ? -signed : 0,
      inflowCents: signed > 0 ? signed : 0,
    });
  }
  const consumed = headerIdx + 1 + rows.length + errors.length;
  return { rows, skipped: Math.max(0, raw.length - consumed), errors };
}

/** `Entrada`/`Saída` cell → cents; a bare `-` or empty cell means 0. */
function parseSide(input: string): number | null {
  const s = input.trim();
  if (isEmptySide(s)) return 0;
  return parseImportAmount(s);
}
