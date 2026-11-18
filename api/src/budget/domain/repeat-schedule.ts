/**
 * repeat-schedule — pure occurrence math shared by the repeat-rules route and
 * the transactions route (PATCH detach). No DB access, no side effects.
 */

import { HttpError } from '../../core/validate';

export { FREQUENCIES, type RepeatFrequency } from '@shared/contracts/budget/frequencies';
import { FREQUENCIES, type RepeatFrequency } from '@shared/contracts/budget/frequencies';

const FREQ_TO_MONTHS: Record<
  Exclude<RepeatFrequency, 'weekly' | 'every-other-week'>,
  number
> = {
  monthly: 1,
  'every-other-month': 2,
  quarterly: 3,
  annually: 12,
};

/** pg hands DATE columns to JS as local-midnight Date objects; API clients
 *  send YYYY-MM-DD strings. Both collapse to the schedule contract here —
 *  local getters for Date (UTC getters shift the calendar day for tz > UTC). */
export function isoDate(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Next occurrence strictly after `date` for the rule's cadence. Month-based
 * frequencies clamp the day-of-month to the target month's length (e.g.
 * Jan 31 -> Feb 28); `monthLastDay` pins to the last day of each month
 * instead. Weekly cadences ignore the flag.
 */
export function advanceOccurrence(
  date: string | Date,
  frequency: RepeatFrequency,
  monthLastDay = false,
): string {
  const iso = isoDate(date);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid date');
  if (frequency === 'weekly') return new Date(d.getTime() + 7 * 86400_000).toISOString().slice(0, 10);
  if (frequency === 'every-other-week') return new Date(d.getTime() + 14 * 86400_000).toISOString().slice(0, 10);
  const months = FREQ_TO_MONTHS[frequency];
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = monthLastDay ? last : Math.min(d.getUTCDate(), last);
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
}
