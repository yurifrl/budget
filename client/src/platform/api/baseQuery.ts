/**
 * RTK Query base query that fetches the running Hono API.
 *
 * Endpoints provide a {@link ApiQuery} describing the HTTP method, path,
 * query params and optional body. The base URL is resolved from the injected
 * Config (EXPO_PUBLIC_API_URL / apiUrl), so tests can override it cleanly.
 */

import type { BaseQueryFn } from '@reduxjs/toolkit/query';
import type { ContractRequest } from '@shared/contract-request';
import { defaultErrorCode, SPECIFIC_ERROR_CODES } from '@shared/errors';
import { tError, translateErrorCode } from '@shared/i18n/errors';

import type { Container } from '../di/container';
import { Tokens } from '../di/tokens';
import { loadAuthHeaders } from '../storage/sessionToken';
import { t } from './i18n';

/**
 * One request: the shape `contractRequest` (shared) builds. Params are
 * stringified here (`undefined` omitted); the body is JSON-serialized unless
 * it is a Blob, which is sent raw with the blob's own content type.
 */
export type ApiQuery = ContractRequest;

export interface ApiQueryError {
  /** HTTP status code, or the literal 'FETCH_ERROR' when fetch itself threw. */
  status: number | 'FETCH_ERROR';
  message: string;
  /** Stable machine-readable code from the API's `{ error, code }` body (shared/src/errors.ts), when present. */
  code?: string;
  /** Values for the `{placeholders}` of the code's message, from the error body's optional `params` object. */
  params?: ErrorParams;
}

type ErrorParams = Readonly<Record<string, string | number>>;

/** Keep only string and number values of a body's `params`; anything else is not a params object. */
function readParams(value: unknown): ErrorParams | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
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
        message: cause instanceof Error ? cause.message : t('network.failed'),
      },
    };
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    let code: string | undefined;
    let params: ErrorParams | undefined;
    try {
      const payload = (await response.json()) as { error?: string; message?: string; code?: unknown; params?: unknown };
      message = payload.error || payload.message || message;
      if (typeof payload.code === 'string') code = payload.code;
      params = readParams(payload.params);
    } catch {
      // ignore parse failure
    }
    return {
      error: {
        status: response.status,
        message,
        ...(code === undefined ? {} : { code }),
        ...(params === undefined ? {} : { params }),
      },
    };
  }

  const data = response.status === 204 ? null : await response.json();
  return { data };
};

const SPECIFIC_CODES: readonly string[] = SPECIFIC_ERROR_CODES;

/** The API `code` of a thrown request error, if it has one. */
export function apiErrorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; data?: { code?: unknown } } | null;
  if (typeof e !== 'object' || e === null) return undefined;
  return typeof e.code === 'string' ? e.code : typeof e.data?.code === 'string' ? e.data.code : undefined;
}

/** One `params` value of a thrown request error (a 409's holder name, say), if it has one. */
export function apiErrorParam(error: unknown, name: string): string | undefined {
  const e = error as { params?: unknown; data?: { params?: unknown } } | null;
  if (typeof e !== 'object' || e === null) return undefined;
  const value = (readParams(e.params) ?? readParams(e.data?.params))?.[name];
  return value === undefined || value === '' ? undefined : String(value);
}

/**
 * Message to show for a thrown RTK Query error (`mutation.unwrap()`), in the
 * active language. Understands our {@link ApiQueryError} shape, RTKQ's
 * serialized-throw blob and `{ data: { message, code } }` wrappers. Order:
 *
 *  1. a specific API code this build has a message for (`invalid_credentials`,
 *     `password_too_short`, ...): that message, with the body's `params`;
 *  2. the caller's `fallback` (a translated sentence naming the action that failed);
 *  3. the per-status code's generic message (`not_found`, `internal`, ...);
 *  4. the raw server text, for a code this build does not know (or no code);
 *  5. the generic `error` message.
 */
export function apiErrorMessage(error: unknown, fallback?: string): string {
  let message: string | undefined;
  let code: string | undefined;
  let status: unknown;
  let params: ErrorParams | undefined;
  if (typeof error === 'object' && error !== null) {
    const e = error as { status?: unknown; message?: unknown; code?: unknown; params?: unknown; data?: { message?: unknown; code?: unknown; params?: unknown } };
    status = e.status;
    if (typeof e.message === 'string') message = e.message;
    else if (typeof e.data?.message === 'string') message = e.data.message;
    if (typeof e.code === 'string') code = e.code;
    else if (typeof e.data?.code === 'string') code = e.data.code;
    params = readParams(e.params) ?? readParams(e.data?.params);
  }
  // fetch itself failed (offline, DNS, server down): the browser's text is English and says nothing useful.
  if (status === 'FETCH_ERROR') return t('network.failed');
  // The transport's placeholder when the body had no text and no code: treat it as that status's generic error.
  if (code === undefined && typeof status === 'number' && message === `HTTP ${status}`) code = defaultErrorCode(status);
  const known = code === undefined ? undefined : translateErrorCode(code, params);
  if (code !== undefined && known !== undefined && SPECIFIC_CODES.includes(code)) return known;
  if (fallback !== undefined) return fallback;
  if (known !== undefined) return known;
  if (message !== undefined) return message;
  return translateErrorCode('error') ?? tError('error');
}
