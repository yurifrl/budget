/** Human-readable rendering of API results (the default; `--json` bypasses this). */

const MAX_COLS = 8;
const MAX_CELL = 40;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
}

export function table(rows: Record<string, unknown>[]): string {
  const cols: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  const shown = cols.slice(0, MAX_COLS);
  const data = rows.map((r) => shown.map((c) => cell(r[c])));
  const widths = shown.map((c, i) => Math.max(c.length, ...data.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((s, i) => s.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  const out = [line(shown), line(widths.map((w) => '-'.repeat(w))), ...data.map(line)];
  if (cols.length > shown.length) out.push(`(${cols.length - shown.length} more columns; use --json)`);
  return out.join('\n');
}

export function humanize(data: unknown): string {
  if (data === null || data === undefined) return 'ok';
  if (Array.isArray(data)) {
    if (data.length === 0) return '(none)';
    if (data.every(isObj)) return table(data as Record<string, unknown>[]);
    return data.map((v) => cell(v)).join('\n');
  }
  if (isObj(data)) {
    const keys = Object.keys(data);
    const w = Math.max(0, ...keys.map((k) => k.length));
    return keys
      .map((k) => {
        const v = data[k];
        return `${k.padEnd(w)}  ${typeof v === 'object' && v !== null ? JSON.stringify(v) : cell(v)}`;
      })
      .join('\n');
  }
  return String(data);
}
