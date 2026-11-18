/**
 * Generic CSV source — auto-detected headers (YNAB export order as the
 * positional fallback) plus the user-confirmed {@link parseMappedCsv} path
 * for unrecognized layouts.
 */

import { parseCsv, sniffDelimiter } from '../util/csv';
import { parseImportDate } from '../util/date';
import { parseImportAmount } from '../util/money';
import type { ColumnKey, CsvMapping, ImportParseResult, ImportRow } from '../../domain/importTypes';

// ---------------------------------------------------------------------------
// Header detection and column mapping
// ---------------------------------------------------------------------------
const HEADER_PATTERNS: { key: ColumnKey; re: RegExp }[] = [
  { key: 'date', re: /^(date|data|data da transação|posted date)$/i },
  { key: 'payee', re: /^(payee|beneficiário|beneficiario|favorecido|lançamento|lancamento|descrição|descrição da transação|description|descrição do lançamento)$/i },
  { key: 'memo', re: /^(memo|note|observação|observacao|detalhe)$/i },
  { key: 'outflow', re: /^(outflow|saída|saida|débito|debito|debit|pagamento)$/i },
  { key: 'inflow', re: /^(inflow|entrada|crédito|credito|credit|recebimento)$/i },
  { key: 'amount', re: /^(valor|amount|quantia|value)$/i },
  { key: 'category', re: /^(category|categoria)$/i },
];

/**
 * YNAB's export order (Date, Payee, Category, Memo, Outflow, Inflow) is the
 * fallback when the file has no recognizable header row.
 */
const POSITIONAL: Record<ColumnKey, number> = {
  date: 0,
  payee: 1,
  category: 2,
  memo: 3,
  outflow: 4,
  inflow: 5,
  amount: -1,
};

function isHeaderRow(cells: string[]): boolean {
  const hits = cells.filter((c) => HEADER_PATTERNS.some((p) => p.re.test(c.trim()))).length;
  return hits >= 2;
}

function columnMap(cells: string[]): Record<ColumnKey, number> {
  const map: Record<ColumnKey, number> = { date: -1, payee: -1, memo: -1, outflow: -1, inflow: -1, amount: -1, category: -1 };
  cells.forEach((cell, idx) => {
    const hit = HEADER_PATTERNS.find((p) => p.re.test(cell.trim()));
    if (hit && map[hit.key] === -1) map[hit.key] = idx;
  });
  return map;
}

function cellAt(cells: string[], idx: number): string {
  return idx >= 0 && idx < cells.length ? cells[idx] : '';
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Turn CSV text into importable rows. Accepts either an Outflow/Inflow pair
 * of columns or a single signed Amount column; rows whose date or amount
 * cannot be parsed are reported in `errors` and excluded.
 *
 * `chargePositive` (credit-card bills, e.g. Itaú fatura exports): a lone
 * positive Amount means money spent, so the sign maps inverted — charges
 * become outflows, negatives become inflows. Explicit Outflow/Inflow
 * columns are left alone either way.
 */
export function parseImportCsv(text: string, opts: { chargePositive?: boolean } = {}): ImportParseResult {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const raw = parseCsv(text, sniffDelimiter(firstLine));
  if (raw.length === 0) return { rows: [], skipped: 0, errors: ['empty file'] };

  let skipped = 0;
  const errors: string[] = [];
  const rows: ImportRow[] = [];

  let header = isHeaderRow(raw[0]);
  let cols: Record<ColumnKey, number> = header ? columnMap(raw[0]) : POSITIONAL;
  if (header && cols.date === -1) {
    errors.push('line 1: header has no date column');
    header = false;
    cols = POSITIONAL;
  }
  if (!header) {
    // No header: only trust the positional layout if it can hold an amount.
    if (raw[0].length < 5) return { rows: [], skipped: raw.length, errors: ['unrecognized CSV layout'] };
  }

  const startIdx = header ? 1 : 0;
  for (let i = startIdx; i < raw.length; i++) {
    const cells = raw[i];
    const line = i + 1;
    const date = parseImportDate(cellAt(cells, cols.date));
    if (!date) {
      errors.push(`line ${line}: unreadable date "${cellAt(cells, cols.date).trim()}"`);
      continue;
    }
    let outflow = parseImportAmount(cellAt(cells, cols.outflow));
    let inflow = parseImportAmount(cellAt(cells, cols.inflow));
    if (cols.amount >= 0) {
      const amount = parseImportAmount(cellAt(cells, cols.amount));
      if (amount === null) {
        errors.push(`line ${line}: unreadable amount "${cellAt(cells, cols.amount).trim()}"`);
        continue;
      }
      if (opts.chargePositive === true) {
        outflow = amount > 0 ? amount : 0;
        inflow = amount < 0 ? -amount : 0;
      } else {
        outflow = amount < 0 ? -amount : 0;
        inflow = amount > 0 ? amount : 0;
      }
    } else if (outflow === null && inflow === null) {
      errors.push(`line ${line}: no readable amount`);
      continue;
    } else {
      outflow = outflow ?? 0;
      inflow = inflow ?? 0;
    }
    if (outflow === 0 && inflow === 0) {
      errors.push(`line ${line}: amount is zero`);
      continue;
    }
    rows.push({
      date,
      payee: cellAt(cells, cols.payee).trim(),
      memo: cellAt(cells, cols.memo).trim(),
      outflowCents: outflow,
      inflowCents: inflow,
    });
  }
  skipped = raw.length - startIdx - rows.length - errors.length;
  return { rows, skipped: Math.max(0, skipped), errors };
}

/**
 * Parse a CSV using a user-confirmed mapping ({@link CsvMapping}) instead of
 * auto-detection — the unknown-layout path of the import sheet. Rows before
 * `mapping.headerRow` are skipped together with the header row itself; each
 * data row is read positionally from the mapped columns.
 */
export function parseMappedCsv(text: string, mapping: CsvMapping): ImportParseResult {
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  const raw = parseCsv(text, mapping.delimiter);
  if (raw.length === 0) return { rows: [], skipped: 0, errors: ['empty file'] };

  for (let i = mapping.headerRow + 1; i < raw.length; i++) {
    const cells = raw[i];
    const line = i + 1;
    const date = parseImportDate(cellAt(cells, mapping.columns.date));
    if (!date) {
      errors.push(`line ${line}: bad date`);
      continue;
    }
    const outRaw = parseImportAmount(cellAt(cells, mapping.columns.outflow));
    const inRaw = parseImportAmount(cellAt(cells, mapping.columns.inflow));
    const amtRaw = parseImportAmount(cellAt(cells, mapping.columns.amount));
    let outflow = 0;
    let inflow = 0;
    if (mapping.columns.amount >= 0) {
      if (amtRaw == null) {
        errors.push(`line ${line}: no readable amount`);
        continue;
      }
      const signed = mapping.chargePositive ? -amtRaw : amtRaw;
      outflow = signed < 0 ? -signed : 0;
      inflow = signed > 0 ? signed : 0;
    } else {
      outflow = mapping.chargePositive ? (inRaw ?? 0) : (outRaw ?? 0);
      inflow = mapping.chargePositive ? (outRaw ?? 0) : (inRaw ?? 0);
    }
    if (outflow === 0 && inflow === 0) {
      errors.push(`line ${line}: amount is zero`);
      continue;
    }
    rows.push({
      date,
      payee: cellAt(cells, mapping.columns.payee).trim(),
      memo: cellAt(cells, mapping.columns.memo).trim(),
      outflowCents: outflow,
      inflowCents: inflow,
    });
  }
  const consumed = mapping.headerRow + 1 + rows.length + errors.length;
  return { rows, skipped: Math.max(0, raw.length - consumed), errors };
}
