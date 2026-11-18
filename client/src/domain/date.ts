/**
 * Calendar-date helpers for the client. A "date" here is a `YYYY-MM-DD`
 * string naming a calendar day, not an instant.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** The user's LOCAL calendar day for an instant, as `YYYY-MM-DD`. `now` is injectable for tests. */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Shift a `YYYY-MM-DD` string by n days. Pure string arithmetic: parsed and
 * formatted in UTC (at noon) so the host zone / DST can never move the day.
 */
export function addDaysToDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
