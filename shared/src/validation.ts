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
/** Integer cents/milliunits, bounded to what bigint + JS number can carry. */
export const centsSchema = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

export const balanceDeltaSchema = z.preprocess(
  // accept snake_case (curl/tests) or camelCase (app client) keys.
  (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const r = raw as Record<string, unknown>;
    return {
      account_id: r.account_id ?? r.accountId,
      cleared_delta: r.cleared_delta ?? r.clearedDelta ?? 0,
      uncleared_delta: r.uncleared_delta ?? r.unclearedDelta ?? 0,
    };
  },
  z.object({
    account_id: uuidSchema,
    cleared_delta: centsSchema,
    uncleared_delta: centsSchema,
  }),
);

export const balanceDeltasSchema = z.array(balanceDeltaSchema).max(100);
