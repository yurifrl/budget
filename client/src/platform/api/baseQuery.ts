/**
 * RTK Query base query that fetches the running Hono API.
 *
 * Endpoints provide a {@link ApiQuery} describing the HTTP method, path,
 * query params and optional body. The base URL is resolved from the injected
 * Config (EXPO_PUBLIC_API_URL / apiUrl), so tests can override it cleanly.
 */

import type { BaseQueryFn } from '@reduxjs/toolkit/query';

import type { Container } from '../di/container';
import { Tokens } from '../di/tokens';
import { loadAuthHeaders } from '../storage/sessionToken';

export interface ApiQuery {
  url: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Values are stringified here; `undefined` entries are omitted from the URL. */
  params?: Record<string, string | number | boolean | undefined>;
  /** JSON-serialized, unless it is a Blob — then sent raw with the blob's own content type. */
  body?: unknown;
}

export interface ApiQueryError {
  /** HTTP status code, or the literal 'FETCH_ERROR' when fetch itself threw. */
  status: number | 'FETCH_ERROR';
  message: string;
  /** Stable machine-readable code from the API's `{ error, code }` body (shared/src/errors.ts), when present. */
  code?: string;
}

const isRaw = (body: unknown): body is Blob => typeof Blob !== 'undefined' && body instanceof Blob;

/** JSON for plain bodies; Blobs (file uploads) go through untouched. */
const serializeBody = (body: unknown): BodyInit | undefined =>
  body === undefined ? undefined : isRaw(body) ? body : JSON.stringify(body);

const contentTypeFor = (body: unknown): Record<string, string> | undefined =>
  body === undefined ? undefined : { 'Content-Type': isRaw(body) ? body.type || 'application/octet-stream' : 'application/json' };

export const apiBaseQuery: BaseQueryFn<ApiQuery, unknown, ApiQueryError> = async (
  query,
  api,
) => {
  const container = api.extra as Container;
  const baseUrl = container.resolve(Tokens.Config).apiUrl.replace(/\/+$/, '');

  const search = new URLSearchParams();
  if (query.params) {
    for (const [key, value] of Object.entries(query.params)) {
      if (value !== undefined) search.set(key, String(value));
    }
  }
  const qs = search.toString();
  const path = query.url.startsWith('/') ? query.url : `/${query.url}`;
  const fullUrl = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;

  // Session rides the cookie on web; on native, the stored token (set by the
  // LoginGate flow) rides as Bearer — see core/storage/sessionToken.ts.
  const auth = await loadAuthHeaders(container.resolve(Tokens.Storage));

  // A rejected fetch (offline, DNS, server down) must surface as an RTKQ
  // error result, not a thrown exception: RTKQ serializes thrown errors into
  // `{ name, message, stack }` blobs and logs "unhandled error" noise.
  let response: Response;
  try {
    response = await fetch(fullUrl, {
      method: query.method ?? 'GET',
      credentials: 'include',
      headers: { ...auth, ...(contentTypeFor(query.body)) },
      body: serializeBody(query.body),
      signal: api.signal,
    });
  } catch (cause) {
    return {
      error: {
        status: 'FETCH_ERROR',
        message: cause instanceof Error ? cause.message : 'Network request failed',
      },
    };
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    let code: string | undefined;
    try {
      const payload = (await response.json()) as { error?: string; message?: string; code?: unknown };
      message = payload.error || payload.message || message;
      if (typeof payload.code === 'string') code = payload.code;
    } catch {
      // ignore parse failure
    }
    return { error: code === undefined ? { status: response.status, message } : { status: response.status, message, code } };
  }

  const data = response.status === 204 ? null : await response.json();
  return { data };
};

/**
 * Human-readable message from a thrown RTK Query error (`mutation.unwrap()`).
 * Understands our {@link ApiQueryError} shape, RTKQ's serialized-throw blob and
 * `{ data: { message } }` wrappers; anything else falls back to `fallback`.
 */
export function apiErrorMessage(error: unknown, fallback = 'request failed'): string {
  if (typeof error === 'object' && error !== null) {
    const e = error as { message?: unknown; data?: { message?: unknown } };
    if (typeof e.message === 'string') return e.message;
    if (typeof e.data?.message === 'string') return e.data.message;
  }
  return fallback;
}
