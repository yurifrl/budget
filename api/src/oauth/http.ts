import type { Context } from 'hono';

/** Cap for every OAuth request body (register/token/revoke/consent). */
const MAX_BODY_BYTES = 8 * 1024;

export class BodyError extends Error {}

/**
 * Read an `application/x-www-form-urlencoded` or JSON body into a flat
 * string map, size-capped. Non-string JSON members are ignored (string
 * params only); arrays/objects for structured fields are returned by
 * readJsonBody instead.
 */
export async function readParams(c: Context): Promise<Record<string, string>> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BodyError('body too large');
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) throw new BodyError('body too large');
  const type = (c.req.header('content-type') ?? '').toLowerCase();
  const out: Record<string, string> = {};
  if (type.includes('application/json')) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BodyError('invalid JSON');
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new BodyError('invalid JSON');
    for (const [k, v] of Object.entries(json)) if (typeof v === 'string') out[k] = v;
    return out;
  }
  for (const [k, v] of new URLSearchParams(text)) if (!(k in out)) out[k] = v;
  return out;
}

export async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BodyError('body too large');
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) throw new BodyError('body too large');
  try {
    const json: unknown = JSON.parse(text);
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) return json as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new BodyError('invalid JSON');
}

/** RFC 6749 section 5.2 error body; never cacheable. */
export function oauthError(c: Context, error: string, description: string, status: 400 | 401 | 403 | 429 = 400) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error, error_description: description }, status);
}
