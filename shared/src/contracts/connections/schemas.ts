/**
 * Zod schemas shared by the connections operation contracts. Pure: imports
 * zod, core/validate and the settings constants only.
 */
import { z } from '../../zod';

import { uuidSchema } from '../../validation';

export { uuidSchema };

export const connectionId = uuidSchema.describe('Connection id (uuid) from the connections list');

/** Upper bound for the sync window, in days (lives here so contracts stay pure). */
export const MAX_SYNC_WINDOW_DAYS = 3650;

/** 0 = all history; 1..MAX caps every pull at N days. */
export const syncWindowDaysSchema = z
  .number()
  .int()
  .refine((n) => n === 0 || (n >= 1 && n <= MAX_SYNC_WINDOW_DAYS), {
    message: `syncWindowDays must be 0 (all history) or 1–${MAX_SYNC_WINDOW_DAYS}`,
  });
