import type { ErrorCode } from '../../errors';

/**
 * One user-facing message per API error code. A code with no message here is a
 * tsc error (`satisfies Record<ErrorCode, string>`), so adding a code to
 * `shared/src/errors.ts` forces a message in `en.ts` and `pt-BR.ts`.
 */
export default {
  // Per-status defaults.
  bad_request: 'The request could not be understood.',
  unauthorized: 'You need to sign in.',
  forbidden: 'You do not have access to this.',
  not_found: 'Not found.',
  conflict: 'This conflicts with the current state. Reload and try again.',
  too_large: 'The request is too large.',
  unprocessable: 'The request could not be processed.',
  rate_limited: 'Too many requests. Try again in a moment.',
  internal: 'Something went wrong on our side. Try again.',
  upstream_error: 'A connected service failed. Try again.',
  unavailable: 'The service is unavailable. Try again later.',
  upstream_timeout: 'A connected service took too long. Try again.',
  error: 'Something went wrong.',
  // Specific codes.
  invalid_input: 'Some of the information entered is not valid.',
  account_disabled: 'This account is disabled.',
  insufficient_scope: 'This access does not allow that action.',
  already_archived: 'This is already archived.',
  invalid_credentials: 'Invalid e-mail or password.',
  temp_password_expired: 'The temporary password expired. Ask an admin for a new one.',
  invalid_change_token: 'Your sign-in expired. Start again.',
  too_many_attempts: 'Too many attempts. Try again later.',
  origin_not_allowed: 'This origin is not allowed.',
  unsupported_media_type: 'The request body must be JSON.',
  no_password: 'This account has no password.',
  password_too_short: 'The password must be at least 12 characters.',
  password_too_long: 'The password must be at most 128 characters.',
  password_is_email: 'The password must not be your e-mail address.',
  password_too_common: 'This password is too common. Choose another.',
  password_unchanged: 'The new password must differ from the current one.',
  password_login_disabled: 'Password sign-in is turned off.',
  user_exists: 'A user with this e-mail already exists.',
  cannot_modify_self: 'You cannot disable, demote or delete yourself.',
  last_admin: 'The last active admin cannot be disabled, demoted or deleted.',
  user_has_data: 'This user has data. Disable them instead.',
} as const satisfies Record<ErrorCode, string>;
