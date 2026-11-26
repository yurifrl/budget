/**
 * Wire schemas of the Jev key operations. The key itself is NEVER returned:
 * only its last four characters and when it was saved.
 */
import { z } from '../../zod';

/**
 * Why no Jev key can be used right now: the budget has no owner (a run has no
 * key to resolve), the `shared-jev-key` feature is off for the owner, the
 * installation's `JEV_API_KEY` is not set, or the saved key cannot be
 * decrypted on this server (CREDENTIALS_ENCRYPTION_KEY missing or changed).
 */
export const jevKeyProblemSchema = z.enum(['no_owner', 'flag_off', 'server_key_missing', 'key_unreadable']);

/**
 * The caller's Jev key status: their own saved key (masked) or the
 * installation's shared key, or the reason neither is available.
 */
export const jevKeyStatusSchema = z.object({
  /** Last four characters of the saved own key; null when none is saved. */
  last_four: z.string().nullable(),
  /** When the saved own key was stored (ISO); null when none is saved. */
  saved_at: z.string().nullable(),
  /** No own key, and the installation's key is available to this person. */
  using_server_key: z.boolean(),
  /** Why no key can be used; null when one can. */
  reason: jevKeyProblemSchema.nullable(),
});

export type JevKeyStatus = z.infer<typeof jevKeyStatusSchema>;
export type JevKeyProblem = z.infer<typeof jevKeyProblemSchema>;

export const jevKeyTestSchema = z.object({
  /** The saved key answered a Jev call. */
  ok: z.boolean(),
});
