/**
 * Request-input validation shared by the feature routers: HttpError, body and
 * value parsing with readable 400 messages, the uuid path-param guard and the
 * shared JSON error mapper.
 *
 * Ids go straight into Postgres uuid columns; an unvalidated literal makes
 * Postgres raise 22P02 and the route surfaces a 500. Guard at the boundary.
 * Domain value schemas (cents, cleared, flag, dates) live in
 * `@shared/validation` and the feature contracts, not here.
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from '@shared/zod';
import { isUuid } from '@shared/validation';

// Generic id validators (shared/); budget value schemas are imported from
// @shared/validation by the code that needs them.
export { UUID_RE, isUuid, uuidSchema } from '@shared/validation';

/** An error carrying the HTTP status it should surface as. */
export class HttpError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
  }
}


/**
 * Parse a JSON request body against a schema.
 * Throws HttpError(400) on unparseable JSON or a schema violation, with the
 * issue list in the message so the client can show what was wrong.
 */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }
  return parseValue(schema, raw);
}

/** Human-friendly one-line message for a zod issue ("budget_id is required"). */
function describeIssue(issue: z.core.$ZodIssue): string {
  const name = issue.path.length > 0 ? issue.path.join('.') : 'request body';
  if (issue.code === 'invalid_type') {
    if (/received undefined$/.test(issue.message)) return `${name} is required`;
    const expected = issue.expected === 'int' ? 'an integer' : `a ${issue.expected}`;
    return `${name} must be ${expected}`;
  }
  if (issue.message === 'must be a uuid') return `${name} must be a valid id`;
  if (issue.code === 'invalid_value') return `${name} is not an allowed value`;
  // Custom messages already read as "must be ..."; zod's own ("Too big: ...") do not.
  return /^must\b/.test(issue.message) ? `${name} ${issue.message}` : `${name} is invalid (${issue.message})`;
}

export function parseValue<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map(describeIssue).join('; '));
  }
  return parsed.data;
}

/** Validate a path/query parameter; throws HttpError(400) with the param name. */
export function requireUuidParam(value: string | undefined, name: string): string {
  if (!isUuid(value)) throw new HttpError(400, `${name} is required (uuid)`);
  return value;
}

/**
 * Shared Hono error mapper: HttpError carries its own status; anything else
 * is an unexpected server fault and must never leak driver internals to the
 * client. Used by index.ts and by in-process route tests.
 */
export function httpOnError(err: unknown, c: Context) {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status);
  }
  console.error('Unhandled API error:', err);
  return c.json({ error: 'internal server error' }, 500);
}
