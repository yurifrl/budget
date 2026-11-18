/**
 * Pure request-input validators shared by contracts and API handlers.
 *
 * Extracted from syscd-app `server/core/validate.ts`: only the zod schemas and
 * `isUuid`. `HttpError`, `parseBody`, `parseValue`, `requireUuidParam` and
 * `httpOnError` depend on hono and stay with the API (phase 2).
 */
import { z } from './zod';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Type guard so a passing check narrows `string | undefined` to `string`. */
export function isUuid(value: string | undefined): value is string {
  return value !== undefined && UUID_RE.test(value);
}

export const uuidSchema = z.string().regex(UUID_RE, 'must be a uuid');
/** YYYY-MM-DD (the first-of-month date months assignments/notes use). */
export const monthDateSchema = z.string().regex(/^\d{4}-\d{2}-01$/, 'must be YYYY-MM-01');
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
/** YNAB flag colors (0004_ynab_compat.sql:166-167). */
export const flagSchema = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple', '']).nullable();
export const clearedSchema = z.enum(['cleared', 'uncleared', 'reconciled']);
/**
 * Money on the wire: every amount, in both directions, is an integer number of
 * MILLIUNITS (1/1000 of the currency unit: 12.34 = 12340, -5 = -5000). Field
 * names carry no unit suffix (`amount`, `inflow`, `balance`, `budgeted`).
 * Any integer is accepted (the database holds YNAB-imported sub-cent values);
 * the app's own writes are always multiples of 10.
 */
export const MONEY_UNIT_RULE =
  'Money: every amount is an integer number of MILLIUNITS (1/1000 of the currency unit; 12.34 = 12340). Amount fields have no unit suffix.';

/** Integer milliunits, bounded to what bigint + JS number can carry. */
export const milliunitsSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .describe('Integer milliunits (1/1000 of the currency unit), e.g. 12.34 = 12340');

/**
 * ISO 4217 currency code ('BRL', 'USD'): trimmed and upper-cased, then exactly
 * three letters. Matches the `accounts_currency_iso4217` CHECK (migration 0100).
 */
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'must be an ISO 4217 currency code (3 letters, e.g. BRL)');

/** Non-negative integer milliunits (one-way inflow / outflow legs). */
export const nonNegativeMilliunitsSchema = milliunitsSchema.min(0);
