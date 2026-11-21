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

export const ERROR_CODE_BY_STATUS = {
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
} as const satisfies Readonly<Record<number, string>>;

/** The per-status default codes (the values of {@link ERROR_CODE_BY_STATUS}). */
export type StatusErrorCode = (typeof ERROR_CODE_BY_STATUS)[keyof typeof ERROR_CODE_BY_STATUS];

/** Codes thrown explicitly somewhere in the API, beyond the per-status defaults. */
export const SPECIFIC_ERROR_CODES = [
  'invalid_input',
  'account_disabled',
  'insufficient_scope',
  'already_archived',
  // Password sign-in and user management (docs/decisions.md).
  'invalid_credentials',
  'temp_password_expired',
  'invalid_change_token',
  'too_many_attempts',
  'origin_not_allowed',
  'unsupported_media_type',
  'no_password',
  'password_too_short',
  'password_too_long',
  'password_is_email',
  'password_too_common',
  'password_unchanged',
  'password_login_disabled',
  'user_exists',
  'cannot_modify_self',
  'last_admin',
  'user_has_data',
] as const;

export type SpecificErrorCode = (typeof SPECIFIC_ERROR_CODES)[number];

/**
 * Every code a client build can know: the per-status defaults, the specific
 * ones, and `error` (the default for an unmapped 4xx). `shared/src/i18n/errors`
 * must have a message for each (a missing one is a tsc error).
 */
export type ErrorCode = StatusErrorCode | SpecificErrorCode | 'error';

export function defaultErrorCode(status: number): string {
  return (ERROR_CODE_BY_STATUS as Readonly<Record<number, string | undefined>>)[status] ?? (status >= 500 ? 'internal' : 'error');
}

export interface ApiErrorBody {
  error: string;
  code: string;
}

export function errorBody(status: number, message: string, code?: string): ApiErrorBody {
  return { error: message, code: code ?? defaultErrorCode(status) };
}
