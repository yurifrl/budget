/**
 * TSV cell codec and value formatting for the budget transfer archive.
 *
 * Every field is wrapped in double quotes; embedded quotes are doubled. The
 * codec is quote-aware, so fields containing tabs (real tab characters inside
 * quoted cells) round-trip correctly.
 *
 * The money/date/month formatters here are deliberately NOT the UI
 * formatters (domain/format): they write the archive's fixed file format
 * (`-R$2496,31`, `DD/MM/YYYY`, `Jan 2026`), independent of the user's number
 * and date prefs, so an export always re-imports. Pinned by tsv.test.ts.
 */

import type { ClearedStatus } from '@/domain/types';

// ---------------------------------------------------------------------------
// Cell quoting / line splitting
// ---------------------------------------------------------------------------

/** Wrap a cell in quotes, doubling any embedded quotes. */
function quoteCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Split one TSV line into raw cell texts: quote-aware (a quoted cell may
 * contain literal tabs and doubled quotes).
 */
function splitCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === '\t') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * Normalize a cell as produced by the writer: tolerate an optional UTF-8 BOM
 * and one level of surrounding quotes with doubled inner quotes.
 */
function normalizeCell(raw: string): string {
  let cell = raw.replace(/^\uFEFF/, '');
  const trimmed = cell.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    cell = trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return cell;
}

/**
 * Parse TSV text (BOM-tolerant, CRLF or LF) into rows of normalized cell
 * strings. The header row is returned separately; trailing blank lines are
 * dropped.
 */
export function parseTsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { header: [], rows: [] };
  const header = splitCells(lines[0]).map(normalizeCell);
  const rows = lines.slice(1).map((l) => splitCells(l).map(normalizeCell));
  return { header, rows };
}

/** Serialize a row: every cell quoted, always a trailing newline. */
export function tsvRow(cells: string[]): string {
  return cells.map(quoteCell).join('\t') + '\n';
}

// ---------------------------------------------------------------------------
// Money (optional -, then R$, then integer, then , + exactly 2 digits)
// ---------------------------------------------------------------------------

/** Format cents as transfer money: `-R$2496,31` / `R$3749,20`. */
export function formatMoney(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}R$${whole},${frac}`;
}

/**
 * Parse transfer money to cents: strips an optional leading minus, any
 * currency symbol / whitespace / thousands noise, and a 2-digit comma
 * decimal. Returns null when nothing numeric remains.
 */
export function parseMoney(cell: string): number | null {
  const negative = cell.includes('-');
  const cleaned = cell.replace(/[^0-9,]/g, '');
  if (cleaned === '') return null;
  const comma = cleaned.indexOf(',');
  const whole = comma === -1 ? cleaned : cleaned.slice(0, comma);
  const frac = comma === -1 ? '0' : cleaned.slice(comma + 1).padEnd(2, '0').slice(0, 2);
  const cents = (whole === '' ? 0 : Number(whole)) * 100 + Number(frac);
  return negative ? -cents : cents;
}

// ---------------------------------------------------------------------------
// Dates & months
// ---------------------------------------------------------------------------

const MONTH_ABBRS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** ISO `YYYY-MM-DD` -> display `DD/MM/YYYY`. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Parse a date cell: `DD/MM/YYYY` primary, ISO `YYYY-MM-DD` accepted. */
export function parseDate(cell: string): string | null {
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(cell.trim());
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(cell.trim())) return cell.trim();
  return null;
}

/** Month key 202610 -> `Oct 2026` (English 3-letter month). */
export function formatMonthCell(month: number): string {
  return `${MONTH_ABBRS[(month % 100) - 1]} ${Math.floor(month / 100)}`;
}

/** `Oct 2026` -> month key 202610, or null when unparseable. */
export function parseMonthCell(cell: string): number | null {
  const m = /^([A-Za-z]{3})\s+(\d{4})$/.exec(cell.trim());
  if (!m) return null;
  const idx = MONTH_ABBRS.findIndex((abbr) => abbr.toLowerCase() === m[1].toLowerCase());
  if (idx === -1) return null;
  return Number(m[2]) * 100 + (idx + 1);
}

// ---------------------------------------------------------------------------
// Cleared
// ---------------------------------------------------------------------------

/** Domain ClearedStatus -> register display cell. */
export function formatCleared(cleared: string): string {
  return cleared.charAt(0).toUpperCase() + cleared.slice(1);
}

/** Register display cell -> domain ClearedStatus (case-insensitive), or null. */
export function parseCleared(cell: string): ClearedStatus | null {
  const lower = cell.trim().toLowerCase();
  if (lower === 'cleared' || lower === 'uncleared' || lower === 'reconciled') return lower;
  return null;
}
