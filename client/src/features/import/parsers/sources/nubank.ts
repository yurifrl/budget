/**
 * Nubank statement source — conta (checking/credit account) and fatura
 * (credit-card bill) CSV exports, zero-config. Rows carry a deterministic
 * YNAB-style `import_id` (`nubank:<id>:<date>:<signedMilli>`) so the bulk
 * endpoint dedupes re-imports exactly like YNAB does.
 */

import { parseCsv, sniffDelimiter } from '../util/csv';
import { parseImportDate } from '../util/date';
import { parseImportAmount } from '../util/money';
import type { ImportParseResult, ImportRow } from '@/domain/importTypes';

/** A parsed row that also carries the dedupe key used by the bulk endpoint. */
export interface NubankRow extends ImportRow {
  /** Deterministic dedupe id, or null when the file has no id column. */
  importId: string | null;
}

export interface NubankParseResult extends ImportParseResult {
  rows: NubankRow[];
}

/** Which Nubank CSV layout the file matches. */
export type NubankLayout = 'conta' | 'fatura';

const has = (cells: string[], re: RegExp): boolean => cells.some((c) => re.test(c.trim()));
const idxOf = (cells: string[], re: RegExp): number => cells.findIndex((c) => re.test(c.trim()));
const cell = (cells: string[], idx: number): string => (idx >= 0 && idx < cells.length ? cells[idx] : '');

/** Detect the Nubank layout from the header row; null when not Nubank. */
export function detectNubankLayout(text: string): NubankLayout | null {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const raw = parseCsv(text, sniffDelimiter(firstLine));
  const header = raw.find((cells) => has(cells, /^(data|date)$/i) && has(cells, /^(valor|amount)$/i));
  if (!header) return null;
  if (has(header, /^title$/i)) return 'fatura';
  if (has(header, /identificador/i) || has(header, /^id$/i)) return 'conta';
  return null;
}

/**
 * Parse a Nubank export. Conta rows are signed (negative = outflow);
 * fatura rows are card-bill style, so a positive amount is a charge
 * (inverted, like the Itaú fatura CSV). The optional id column becomes
 * the row's deterministic dedupe key.
 */
export function parseNubankCsv(text: string, layout: NubankLayout): NubankParseResult {
  const rows: NubankRow[] = [];
  const errors: string[] = [];
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const raw = parseCsv(text, sniffDelimiter(firstLine));
  if (raw.length === 0) return { rows, skipped: 0, errors: ['empty file'] };

  const headerIdx = raw.findIndex((cells) => has(cells, /^(data|date)$/i) && has(cells, /^(valor|amount)$/i));
  if (headerIdx === -1) return { rows, skipped: 0, errors: ['not a Nubank statement'] };
  const header = raw[headerIdx];
  const dateCol = idxOf(header, /^(data|date)$/i);
  const amountCol = idxOf(header, /^(valor|amount)$/i);
  const idCol = layout === 'conta' ? idxOf(header, /identificador/i) : idxOf(header, /^id$/i);
  const payeeCol = layout === 'conta' ? idxOf(header, /^descri/i) : idxOf(header, /^title$/i);

  for (let i = headerIdx + 1; i < raw.length; i++) {
    const cells = raw[i];
    const line = i + 1;
    const date = parseImportDate(cell(cells, dateCol));
    if (!date) {
      errors.push(`line ${line}: bad date`);
      continue;
    }
    const amount = parseImportAmount(cell(cells, amountCol));
    if (amount == null) {
      errors.push(`line ${line}: no readable amount`);
      continue;
    }
    const signed = layout === 'fatura' ? -amount : amount;
    const outflow = signed < 0 ? -signed : 0;
    const inflow = signed > 0 ? signed : 0;
    if (outflow === 0 && inflow === 0) {
      errors.push(`line ${line}: amount is zero`);
      continue;
    }
    const id = cell(cells, idCol).trim();
    rows.push({
      date,
      payee: cell(cells, payeeCol).trim(),
      memo: '',
      outflowCents: outflow,
      inflowCents: inflow,
      importId: id ? `nubank:${id}:${date}:${(inflow - outflow) * 10}` : null,
    });
  }
  const consumed = headerIdx + 1 + rows.length + errors.length;
  return { rows, skipped: Math.max(0, raw.length - consumed), errors };
}
