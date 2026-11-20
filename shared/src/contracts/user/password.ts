/**
 * E-mail + password sign-in (see docs/decisions.md, "Password sign-in and
 * user management"). Api only: never a CLI command or an MCP tool.
 *
 * Errors (body `{ error, code }`):
 *  - 400 `invalid_input`: the body does not parse;
 *  - 401 `invalid_credentials`: unknown e-mail, no password, wrong password or
 *    disabled account (indistinguishable on purpose);
 *  - 401 `temp_password_expired`: only after the temporary password itself
 *    was correct;
 *  - 401 `invalid_change_token`: the change token is expired, already used or
 *    not a change token;
 *  - 400 `password_too_short` | `password_too_long` | `password_is_email` |
 *    `password_too_common` | `password_unchanged`: the chosen password;
 *  - 403 `origin_not_allowed`: an Origin header that is not an app/admin origin;
 *  - 403 `forbidden` (change only): not a first-party session;
 *  - 404 `not_found`: password login is off (AUTH_PASSWORD_LOGIN=0);
 *  - 429 `too_many_attempts` + `Retry-After` (seconds): the e-mail is locked
 *    after repeated failures, or this client address made too many failures.
 */
import { z } from '../../zod';

import { defineOperation, type OperationExpose } from '../../operation-contract';

const EXPOSE_API_ONLY: OperationExpose = { api: true, cli: false, mcp: false };

/** How the session is handed over: web = httpOnly cookie, native = `token` in the body (Bearer). */
export const sessionDeliverySchema = z.enum(['cookie', 'token']);
export type SessionDelivery = z.infer<typeof sessionDeliverySchema>;

/** Signed in. `token` is present only when `session: 'token'` was asked for (and then no cookie is set). */
export const passwordSignedInSchema = z.object({
  status: z.literal('signed_in'),
  email: z.string(),
  token: z.string().optional(),
});

/**
 * The password was a correct, unexpired TEMPORARY password: no session yet.
 * Send `change_token` with a new password to /auth/password/complete within
 * `expires_in` seconds.
 */
export const passwordChangeRequiredSchema = z.object({
  status: z.literal('password_change_required'),
  email: z.string(),
  change_token: z.string(),
  expires_in: z.number().int(),
});

export const passwordLoginResultSchema = z.discriminatedUnion('status', [passwordSignedInSchema, passwordChangeRequiredSchema]);
export type PasswordLoginResult = z.infer<typeof passwordLoginResultSchema>;

const emailInput = z.string().trim().toLowerCase().min(1).max(320);
/** Upper bound only (avoid hashing huge bodies); the policy decides the rest. */
const passwordInput = z.string().min(1).max(1024);

export const authPasswordLogin = defineOperation({
  name: 'user_auth_password_login',
  description:
    'Sign in with e-mail and password. session=cookie (default, web) sets the session cookie; session=token (native) returns { token } and sets no cookie. A temporary password returns status password_change_required with a short-lived change_token instead of a session.',
  input: z.object({
    email: emailInput,
    password: passwordInput,
    session: sessionDeliverySchema.optional(),
  }),
  output: passwordLoginResultSchema,
  method: 'POST',
  path: '/auth/password/login',
  kind: 'write',
  expose: EXPOSE_API_ONLY,
});

export const authPasswordComplete = defineOperation({
  name: 'user_auth_password_complete',
  description:
    'Finish a temporary-password sign-in: set a new password with the change_token from login, then sign in (cookie or token, as for login). The change token works once.',
  input: z.object({
    change_token: z.string().min(1).max(4096),
    new_password: passwordInput,
    session: sessionDeliverySchema.optional(),
  }),
  output: passwordSignedInSchema,
  method: 'POST',
  path: '/auth/password/complete',
  kind: 'write',
  expose: EXPOSE_API_ONLY,
});

/** `token`: the caller's re-issued session, only when it came as a Bearer password session (a cookie caller gets a new cookie). */
export const passwordChangeResultSchema = z.object({ ok: z.literal(true), token: z.string().optional() });

export const authPasswordChange = defineOperation({
  name: 'user_auth_password_change',
  description:
    "Change your password (signed-in first-party session only; not an OAuth token or the service token). Re-verifies the current password; ends your other password sessions and re-issues this one.",
  input: z.object({ current_password: passwordInput, new_password: passwordInput }),
  output: passwordChangeResultSchema,
  method: 'POST',
  path: '/auth/password/change',
  kind: 'write',
  expose: EXPOSE_API_ONLY,
});
