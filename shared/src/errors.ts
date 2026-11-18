/**
 * API error shape. Every non-OAuth JSON error response is
 * `{ error: string, code: string }`: `error` is the human-readable message
 * (unchanged, kept for compatibility), `code` a stable machine-readable
 * identifier clients can branch on. OAuth endpoints keep RFC 6749's
 * `{ error, error_description }` (there `error` already is a code).
 *
 * A handler may throw a specific code (`account_disabled`,
 * `already_archived`, `insufficient_scope`, `invalid_input`); otherwise the
 * code follows the HTTP status.
 */

export const ERROR_CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  422: 'unprocessable',
  429: 'rate_limited',
  500: 'internal',
  502: 'upstream_error',
  503: 'unavailable',
  504: 'upstream_timeout',
};

/** Codes thrown explicitly somewhere in the API, beyond the per-status defaults. */
export const SPECIFIC_ERROR_CODES = ['invalid_input', 'account_disabled', 'insufficient_scope', 'already_archived'] as const;

export function defaultErrorCode(status: number): string {
  return ERROR_CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal' : 'error');
}

export interface ApiErrorBody {
  error: string;
  code: string;
}

export function errorBody(status: number, message: string, code?: string): ApiErrorBody {
  return { error: message, code: code ?? defaultErrorCode(status) };
}
