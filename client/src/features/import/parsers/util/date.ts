/**
 * Statement-import date coercion — pure helpers.
 */

// ---------------------------------------------------------------------------
// Dates: DD/MM/YYYY, DD/MM/YY, YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY
// ---------------------------------------------------------------------------
/** Parse a CSV date cell into ISO "YYYY-MM-DD"; null when unparseable. */
export function parseImportDate(input: string): string | null {
  const s = input.trim().replace(/^"|"$/g, '');
  if (!s) return null;
  let parts: string[];
  let iso: string;
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s)) {
    parts = s.split(/[-/.]/);
    iso = `${parts[0]}-${pad(parts[1])}-${pad(parts[2])}`;
  } else if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s)) {
    parts = s.split(/[-/.]/);
    let day = Number(parts[0]);
    let month = Number(parts[1]);
    // pt-BR default is DD/MM; if the second component cannot be a month
    // (13+) while the first can, treat the line as MM/DD.
    if (month > 12 && day <= 12) [day, month] = [month, day];
    let year = Number(parts[2]);
    if (parts[2].length === 2) year += year < 69 ? 2000 : 1900;
    iso = `${year}-${pad(month)}-${pad(day)}`;
  } else {
    return null;
  }
  // Round-trip: rejects rolled-over dates like 31/02 (Bun's Date.parse is
  // lenient and would map them to the next month instead of NaN).
  const t = Date.parse(`${iso}T00:00:00Z`);
  const d = new Date(t);
  const [y, m, day] = iso.split("-").map(Number);
  if (
    Number.isNaN(t) ||
    t < Date.parse("1900-01-01") ||
    t > Date.parse("2100-01-01") ||
    d.getUTCFullYear() !== y ||
    d.getUTCMonth() + 1 !== m ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return iso;
}

function pad(n: number | string): string {
  return String(n).padStart(2, '0');
}
