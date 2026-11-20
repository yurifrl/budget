/**
 * GET /auth/providers: which sign-in flows this API offers, so a client can
 * pick one without trying them. Open (pre-gate), answers the same to
 * everyone; it reveals only which providers are switched on.
 */
import { z } from '../../zod';

import { defineOperation } from '../../operation-contract';

export const authProvidersSchema = z.object({
  /** Cloudflare Access sign-in (/auth/access, /auth/access/native). */
  access: z.boolean(),
  /** Google sign-in (/auth/google, /auth/google/native). */
  google: z.boolean(),
  /** E-mail + password sign-in (/auth/password/login); off with AUTH_PASSWORD_LOGIN=0. */
  password: z.boolean(),
});

export const authProviders = defineOperation({
  name: 'user_auth_providers',
  description: 'Sign-in providers this API offers: { access, google, password } (Cloudflare Access, Google, e-mail + password). Open; no session needed.',
  input: z.object({}),
  output: authProvidersSchema,
  method: 'GET',
  path: '/auth/providers',
  kind: 'read',
  expose: { api: true, cli: false, mcp: false },
});
