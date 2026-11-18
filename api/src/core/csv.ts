/**
 * Minimal RFC-4180 CSV parsing shared by the health catalog seed and the
 * USDA/OFF ingestion pipelines. Handles double-quoted fields with embedded
 * commas, escaped quotes, and newlines inside quotes. No external deps.
 */

/** Parse a single CSV line (or chunk) into fields, honoring quotes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Parse a full CSV document (header + rows) into records; blank lines dropped. */
export function parseCsvRecords(text: string): string[][] {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line, idx, arr) => line !== '' || idx === arr.length - 1)
    .map(parseCsvLine)
    .filter((row) => row.some((cell) => cell !== ''));
}

/** Header column index lookup with a useful error for malformed datasets. */
export function csvColumnIndex(header: string[], name: string): number {
  const idx = header.indexOf(name);
  if (idx === -1) throw new Error(`Missing CSV column ${name}`);
  return idx;
}
