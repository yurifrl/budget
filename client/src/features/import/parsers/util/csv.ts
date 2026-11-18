/**
 * RFC 4180 CSV — quoted fields, escaped quotes, commas/newlines inside
 * quotes — plus delimiter sniffing for pt-BR exports.
 */

// ---------------------------------------------------------------------------
// CSV (RFC 4180): quoted fields, escaped quotes, commas/newlines inside quotes
// ---------------------------------------------------------------------------
/**
 * Parse CSV text into rows of cells. Empty lines are dropped. `delimiter`
 * defaults to ","; callers sniff ";" or tab files (common pt-BR Excel
 * exports, where the decimal comma forces the other separator) themselves.
 */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      started = false;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (started || cell !== '' || row.length > 0) {
        row.push(cell);
        if (row.some((c) => c.trim() !== '')) rows.push(row);
        row = [];
        cell = '';
        started = false;
      }
      continue;
    }
    cell += ch;
    started = true;
  }
  if (started || cell !== '' || row.length > 0) {
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
  }
  return rows;
}

// Main entry
// ---------------------------------------------------------------------------
/**
 * Pick the field separator for a CSV: whichever of comma / semicolon / tab
 * appears most often on the first non-empty line. pt-BR bank exports use ";"
 * because the decimal comma makes Excel default to it.
 */
export function sniffDelimiter(firstLine: string): string {
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    const n = firstLine.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}
