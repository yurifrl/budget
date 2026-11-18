/**
 * Itaú statement source — account extrato TXT ("dd/mm/yyyy;payee;value")
 * and the BIFF8/SheetJS XLS exports (extrato + fatura).
 */

import * as XLSX from 'xlsx';

import { parseImportDate } from '../util/date';
import { parseImportAmount } from '../util/money';
import type { ImportParseResult, ImportRow } from '@/domain/importTypes';

// ---------------------------------------------------------------------------
// Itaú extrato TXT: "dd/mm/yyyy;payee;value" — signed pt-BR amounts
// ---------------------------------------------------------------------------
/**
 * Parse an Itaú account-statement TXT export: semicolon lines of date,
 * payee and signed value (negative = outflow). Extra trailing fields are
 * ignored, matching ynabu's parser. No header row exists.
 */
export function parseItauExtratoTxt(text: string): ImportParseResult {
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const cells = line.split(';');
    if (cells.length < 3) {
      errors.push(`line ${i + 1}: expected "date;payee;value"`);
      continue;
    }
    pushExtratoRow(cells, 2, i + 1, rows, errors);
  }
  return { rows, skipped: 0, errors };
}

/**
 * Shared row coercion for the extrato layouts (TXT + XLS): `cells[0]` is the
 * dd/mm/yyyy date, `cells[1]` the payee and `cells[valueIdx]` a signed
 * amount (negative = outflow). XLS rows carry raw numeric cells — read
 * directly as cents with no locale round-trip; text rows go through the
 * pt-BR amount parser. Bad rows land in `errors` with the `line` label; good
 * rows are appended to `rows`.
 */
function pushExtratoRow(
  cells: SheetCell[],
  valueIdx: number,
  line: number,
  rows: ImportRow[],
  errors: string[],
): void {
  const date = parseImportDate(String(cells[0]));
  if (!date) {
    errors.push(`line ${line}: unreadable date "${String(cells[0]).trim()}"`);
    return;
  }
  const rawAmount = cells[valueIdx];
  const amount = typeof rawAmount === 'number'
    ? Math.round(rawAmount * 100)
    : parseImportAmount(String(rawAmount ?? ''));
  if (amount === null) {
    errors.push(`line ${line}: unreadable amount "${String(rawAmount).trim()}"`);
    return;
  }
  if (amount === 0) {
    errors.push(`line ${line}: amount is zero`);
    return;
  }
  rows.push({
    date,
    payee: String(cells[1]).trim(),
    memo: '',
    outflowCents: amount < 0 ? -amount : 0,
    inflowCents: amount > 0 ? amount : 0,
  });
}

// ---------------------------------------------------------------------------
// Itaú XLS exports: binary BIFF8 workbooks (account extrato + credit-card
// fatura), read through SheetJS. Both sheets carry date/payee/…/value in
// columns 0/1/3; the fatura adds card-total section headers between blocks.
// ---------------------------------------------------------------------------

/**
 * One sheet row as raw cell values: `raw: true` returns numeric cells as JS
 * numbers (the source of truth in BIFF8) instead of the file's display text,
 * which follows the workbook's locale (en-US "5,200.00" in current Itaú
 * exports) and would corrupt pt-BR amount parsing by 100×. Display strings
 * would also lose precision for amounts > 2 decimals. `defval: ''` keeps
 * column gaps as empty cells.
 */
type SheetCell = string | number | Date;

/**
 * OLE2 compound-document (BIFF8 `.xls`) and ZIP (`.xlsx`) container
 * signatures. SheetJS otherwise happily parses arbitrary bytes as a one-cell
 * CSV sheet, which would surface as confusing per-row errors instead of an
 * honest "unreadable" rejection.
 */
function assertXlsContainer(bytes: Uint8Array): void {
  const ole2 = bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  const zip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!ole2 && !zip) throw new Error('not an XLS/XLSX container');
}

function xlsRows(bytes: Uint8Array): SheetCell[][] {
  assertXlsContainer(bytes);
  const workbook = XLSX.read(bytes, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<SheetCell[]>(sheet, { header: 1, raw: true, defval: '' });
}

/** The account-statement XLS starts its transaction block at this row label. */
const EXTRATO_SECTION = 'lançamentos';

/**
 * Parse an Itaú account-statement XLS: rows before the "lançamentos" section
 * header are ignored, then date/payee/value come from columns 0/1/3 (signed
 * amounts, same as the TXT export).
 */
export function parseItauExtratoXls(bytes: Uint8Array): ImportParseResult {
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  let raw: SheetCell[][];
  try {
    raw = xlsRows(bytes);
  } catch {
    return { rows, skipped: 0, errors: ['unreadable XLS file'] };
  }
  if (raw.length === 0) return { rows, skipped: 0, errors: ['no data found in sheet'] };
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const cells = raw[i];
    if (cells.length < 4) continue;
    const label = String(cells[0]).trim().toLowerCase();
    if (!started) {
      if (label === EXTRATO_SECTION) started = true;
      continue;
    }
    // Structural rows between transactions — repeated section labels
    // ("Lançamentos" — Itaú re-emits it on every page — plus
    // "Lançamentos futuros"/"Saídas futuras"), the column header row
    // ("data | lançamento | …") and blank spacer rows. Real transactions
    // always carry a dd/mm/yyyy date here, so anything else is layout, not
    // data, and must not surface as an error.
    if (label === '' || label === 'data' || label === EXTRATO_SECTION || label === 'lançamentos futuros' || label === 'saídas futuras') {
      continue;
    }
    // Daily-balance rows ("SALDO ANTERIOR", "SALDO TOTAL DISPONÍVEL DIA")
    // carry the running balance in the "saldos" column with no transaction
    // value — skipping by payee, not by empty value, keeps a genuinely bad
    // transaction row an error.
    if (/^saldo/i.test(String(cells[1]).trim())) continue;
    pushExtratoRow(cells, 3, i + 1, rows, errors);
  }
  if (!started) {
    return { rows, skipped: 0, errors: ['no "lançamentos" section found in sheet — not an Itaú extrato XLS'] };
  }
  return { rows, skipped: 0, errors };
}

/**
 * Excel day-serial (1900 date system, SheetJS `raw: true` date cells) →
 * ISO "yyyy-mm-dd". 25569 is the serial of 1970-01-01; date cells carry no
 * time-of-day, so the UTC conversion cannot shift a day.
 */
function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  return new Date((serial - 25569) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Fatura date cells: current XLSX exports store raw Excel serials, legacy
 * exports plain dd/mm/yyyy text.
 */
function faturaDate(cell: SheetCell | undefined): string | null {
  if (typeof cell === 'number') return excelSerialToIsoDate(cell);
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  const text = String(cell ?? '').trim();
  return text === '' ? null : parseImportDate(text);
}

/**
 * Row memo for the 2026 fatura layout: titularidade ("Titular"/"Adicional")
 * plus the row's own card number ("****1234" → "*1234", falling back to the
 * bill-summary card), with installments ("Parcela 2 de 12" → " · 2/12").
 */
function faturaRowMemo(cells: SheetCell[], summaryCard: string): string {
  const kind = String(cells[6] ?? '').trim().toLowerCase();
  const cardNum = /(\d+)\s*$/.exec(String(cells[9] ?? '').trim())?.[1];
  const base = cardNum !== undefined
    ? `${kind !== '' ? `${kind} ` : ''}*${cardNum}`
    : summaryCard !== ''
      ? summaryCard
      : kind;
  const parcela = /^parcela (\d+) de (\d+)\s*$/.exec(String(cells[3] ?? '').trim().toLowerCase());
  return parcela ? `${base} · ${parcela[1]}/${parcela[2]}` : base;
}

/**
 * Parse an Itaú credit-card bill (fatura) XLSX/XLS. The 2026 XLSX export
 * indents every row one column: the summary block ("Fatura … - Mês/Ano",
 * the card "… - final 3537" with total + vencimento), the "Lançamentos"
 * section header and the column headers all carry their labels in column
 * 1, and transaction rows hold an Excel-serial date in column 1, the
 * merchant in column 2, an optional "Parcela n de m" in column 3 and the
 * signed BRL amount in column 4 — positive = charge, negative =
 * payment/refund — with titularidade (column 6) and the row's own card
 * "****1234" (column 9) kept as the memo. Legacy .xls exports keep the
 * older shape: dd/mm/yyyy in column 0, merchant in 1, "R$ x,xx" charge in
 * 3, card totals ("Total Nacional do Cartão - final 1234 (titular)")
 * supplying the card memo. Charges map to outflows, payments/refunds to
 * inflows. Header, summary, subtotal and disclaimer rows carry no date in
 * the date column and are skipped; a sheet that yields no transactions is
 * rejected explicitly instead of silently importing nothing.
 */
export function parseItauFaturaXls(bytes: Uint8Array): ImportParseResult {
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  let raw: SheetCell[][];
  try {
    raw = xlsRows(bytes);
  } catch {
    return { rows, skipped: 0, errors: ['unreadable XLS file'] };
  }
  if (raw.length === 0) return { rows, skipped: 0, errors: ['no data found in sheet'] };
  let card = '';
  for (let i = 0; i < raw.length; i++) {
    const cells = raw[i];
    const first = String(cells[0] ?? '').trim();
    const isNew = first === '';
    if (cells.length < (isNew ? 5 : 4)) continue;
    const labelLower = (isNew ? String(cells[1] ?? '') : first).trim().toLowerCase();
    // Card summary rows (either layout) refresh the fallback card memo:
    // legacy "Total Nacional do Cartão - final 1234 (titular)" or the
    // 2026 "…Mastercard - final 3537" bill summary.
    const summaryHit = /(?:total nacional do cartão[^\d]*|-\s*)final (\d+)/.exec(labelLower);
    if (summaryHit) {
      const kind = labelLower.includes('(titular)')
        ? 'titular'
        : labelLower.includes('(adicional)')
          ? 'adicional'
          : '';
      card = `${kind !== '' ? `${kind} ` : ''}*${summaryHit[1]}`;
    }
    if (labelLower.includes('total') || labelLower === 'data') continue;
    const date = isNew ? faturaDate(cells[1]) : parseImportDate(first);
    if (date === null) {
      if (!isNew && /\d{2}\/\d{2}/.test(first)) errors.push(`line ${i + 1}: unreadable date "${first}"`);
      continue; // headers, totals, section labels, bill title, disclaimers
    }
    // Charges are positive amounts in either layout ("R$ 1.234,56" text
    // legacy, raw numeric cells now): negate, then map sign (charge →
    // outflow, payment/refund → inflow).
    const amountCell = isNew ? cells[4] : cells[3];
    const amount = typeof amountCell === 'number'
      ? Math.round(amountCell * 100)
      : parseImportAmount(String(amountCell ?? ''));
    if (amount === null) {
      errors.push(`line ${i + 1}: unreadable amount "${String(amountCell ?? '').trim()}"`);
      continue;
    }
    const signed = -amount;
    if (signed === 0) {
      errors.push(`line ${i + 1}: amount is zero`);
      continue;
    }
    rows.push({
      date,
      payee: (isNew ? String(cells[2] ?? '') : String(cells[1] ?? '')).trim(),
      memo: isNew ? faturaRowMemo(cells, card) : card,
      outflowCents: signed < 0 ? -signed : 0,
      inflowCents: signed > 0 ? signed : 0,
    });
  }
  if (rows.length === 0 && errors.length === 0) {
    return { rows, skipped: 0, errors: ['no fatura transactions found in sheet — not an Itaú fatura XLS'] };
  }
  return { rows, skipped: 0, errors };
}
