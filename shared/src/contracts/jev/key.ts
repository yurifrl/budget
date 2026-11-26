/**
 * The caller's OWN Jev key (an OpenRouter key used for Jev), one per user.
 * User-scoped: every operation acts on the signed-in user's row only; there is
 * no id to pass and no budget involved.
 *
 * Error codes (body `{ error, code }`):
 *   jev_key_rejected        400  Jev refused the key (save, test)
 *   jev_unavailable         502  Jev could not be reached (save, test)
 *   jev_key_missing         400  test with no saved key
 *   credentials_key_missing 503  the installation has no encryption key configured
 */
import { z } from '../../zod';

import { defineOperation, EXPOSE_NO_MCP } from '../../operation-contract';
import { jevKeyStatusSchema, jevKeyTestSchema } from './outputs';

const API_ONLY = { api: true, cli: false, mcp: false } as const;

export const JEV_KEY_REJECTED = 'jev_key_rejected';
export const JEV_UNAVAILABLE = 'jev_unavailable';
export const JEV_KEY_MISSING = 'jev_key_missing';
/** Jev refused the call because the OpenRouter account behind the key has no credits. */
export const JEV_NO_CREDITS = 'jev_no_credits';
export const CREDENTIALS_KEY_MISSING = 'credentials_key_missing';

export const jevKeyGet = defineOperation({
  name: 'jev_key_get',
  description:
    "Status of the current user's Jev key: the last four characters of their saved key and when it was saved, or the installation's shared key in use, or the reason no key is available. The key itself is never returned.",
  input: z.object({}),
  output: jevKeyStatusSchema,
  method: 'GET',
  path: '/jev/key',
  kind: 'read',
  expose: EXPOSE_NO_MCP,
});

export const jevKeySave = defineOperation({
  name: 'jev_key_save',
  description:
    "Save or replace the current user's Jev key (an OpenRouter key). The key is checked with Jev first: 400 jev_key_rejected if Jev refuses it, 502 jev_unavailable if Jev cannot be reached (nothing is stored either way). The key is stored encrypted and never returned; the answer is the same status jev_key_get gives. 503 credentials_key_missing if the installation has no encryption key.",
  // 20 characters is the shortest any of these keys is, and it keeps every
  // stored key long enough for the server's redaction to always match it.
  input: z.object({ key: z.string().trim().min(20).max(400) }),
  output: jevKeyStatusSchema,
  method: 'PUT',
  path: '/jev/key',
  kind: 'write',
  // A secret on a command line lands in shell history; in an MCP call, in a model's context.
  expose: API_ONLY,
});

export const jevKeyTest = defineOperation({
  name: 'jev_key_test',
  description:
    "Make one Jev call with the current user's saved key (made-up transaction data, no budget data) and report whether Jev answered it. 400 jev_key_missing when no own key is saved, 400 jev_key_rejected when Jev refuses it, 502 jev_unavailable when Jev cannot be reached.",
  input: z.object({}),
  output: jevKeyTestSchema,
  method: 'POST',
  path: '/jev/key/test',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const jevKeyDelete = defineOperation({
  name: 'jev_key_delete',
  description:
    "Delete the current user's saved Jev key. Idempotent. After it, runs use the installation's shared key when the shared-jev-key feature is on, or no key at all.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  method: 'DELETE',
  path: '/jev/key',
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});
