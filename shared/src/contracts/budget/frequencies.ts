/**
 * Repeat-rule frequencies. Extracted from syscd-app
 * `server/budget/domain/repeat-schedule.ts`; the occurrence math there throws
 * HttpError (hono) so it stays with the API.
 */

/** Recurrence frequencies a repeat rule can use (migration 0011 check). */
export const FREQUENCIES = [
  'weekly',
  'every-other-week',
  'monthly',
  'every-other-month',
  'quarterly',
  'annually',
] as const;

export type RepeatFrequency = (typeof FREQUENCIES)[number];
