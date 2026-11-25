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

/**
 * Codes thrown explicitly somewhere in the API, beyond the per-status defaults.
 * A specific code is only ever attached to an error the signed-in person can
 * cause with a screen the app offers; bare `not found` / `unauthorized`,
 * webhook, cursor/date and jobs-admin errors stay on the per-status default
 * (a specific code there would tell a non-member apart from a missing row).
 */
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
  // Sign-in flows (Cloudflare Access, native exchange).
  'invalid_code',
  'invalid_redirect_uri',
  'access_assertion_missing',
  'access_assertion_invalid',
  'email_already_provisioned',
  'email_reserved',
  'password_changed_meanwhile',
  // Profile photo upload.
  'image_empty',
  'image_too_large',
  'unsupported_image_type',
  'image_dimensions_too_large',
  'image_undecodable',
  // Bank connections.
  'pluggy_keys_rejected',
  'credentials_key_missing',
  'own_keys_required',
  'connection_paused',
  'item_not_reachable',
  'provider_unreadable',
  'provider_request_failed',
  'provider_not_configured',
  'connection_already_registered',
  'connection_disconnected',
  'connection_still_linked',
  // AI keys (category suggestions).
  'own_ai_key_required',
  'ai_key_rejected',
  'ai_provider_unknown',
  'ai_provider_mismatch',
  'ai_model_unknown',
  'ai_key_encryption_missing',
  'ai_key_unreadable',
  'ai_shared_key_missing',
  'ai_shared_model_missing',
  // Categorize page (queue, accept/undo/skip, threshold).
  'categorize_ai_unavailable',
  'categorize_already_categorized',
  'categorize_not_needing_category',
  'categorize_bundle_changed',
  'categorize_bundle_too_large',
  'category_not_assignable',
  // Budget: accounts, transactions, transfers, repeats.
  'cannot_transfer_to_same_account',
  'transfer_account_not_in_budget',
  'account_closed',
  'account_closed_edit',
  'account_closed_reconcile',
  'account_not_in_budget',
  'category_not_in_budget',
  'split_cannot_have_category',
  'transfer_cannot_be_split',
  'transfer_link_target',
  'transfer_already_linked',
  'transfer_off_budget',
  'transfer_amount_mismatch',
  'transfer_rule_needs_account',
  'transaction_already_repeating',
  'bank_account_already_linked',
  'account_must_be_closed_first',
  'account_name_exists',
  'member_not_in_budget',
  // Budget: payees, bundles, people, backup.
  'payee_name_reserved',
  'transfer_payee_protected',
  'payee_not_in_budget',
  'payee_name_deleted_exists',
  'payee_name_exists',
  'rename_rule_exists',
  'rename_rule_too_short',
  'bank_sync_running',
  'cannot_merge_into_itself',
  'bundle_needs_two_categories',
  'member_name_required',
  'person_already_has_email',
  'person_edits_own_name',
  'owner_cannot_be_removed',
  'invalid_backup',
  'invalid_transaction_id',
] as const;

/**
 * `status_message` / sync-run `user_message` are server-written English
 * sentences stored in the database (a closed set of 12). The API adds
 * `status_message_code` / `user_message_code` next to them, holding one of
 * these codes; the message for each lives in the errors catalog under the
 * same name (`translateErrorCode(code)`).
 */
export const SERVER_MESSAGE_CODES = [
  'server_reconnect_bank',
  'server_quota_exhausted',
  'server_rate_limited',
  'server_transient',
  'server_permanent',
  'server_paused_shared_keys',
  'server_paused_own_keys',
  'server_run_paused',
  'server_cancelled_before_start',
  'server_cancelled',
  'server_job_failed',
  'server_job_unavailable',
] as const;

export type ServerMessageCode = (typeof SERVER_MESSAGE_CODES)[number];

export type SpecificErrorCode = (typeof SPECIFIC_ERROR_CODES)[number];

/**
 * Every code a client build can know: the per-status defaults, the specific
 * ones, and `error` (the default for an unmapped 4xx). `shared/src/i18n/errors`
 * must have a message for each (a missing one is a tsc error).
 */
export type ErrorCode = StatusErrorCode | SpecificErrorCode | ServerMessageCode | 'error';

export function defaultErrorCode(status: number): string {
  return (ERROR_CODE_BY_STATUS as Readonly<Record<number, string | undefined>>)[status] ?? (status >= 500 ? 'internal' : 'error');
}

/** Values for the `{placeholders}` of a code's catalog message. */
export type ErrorParams = Readonly<Record<string, string | number>>;

export interface ApiErrorBody {
  error: string;
  code: string;
  /** Present only when the code's message has placeholders (a payee name, a limit). Additive. */
  params?: ErrorParams;
}

export function errorBody(status: number, message: string, code?: string, params?: ErrorParams): ApiErrorBody {
  return {
    error: message,
    code: code ?? defaultErrorCode(status),
    ...(params === undefined ? {} : { params }),
  };
}
