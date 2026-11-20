/**
 * Profile operation contracts (pure data — zod + core contract types only).
 * Handlers live in routes.ts. Only the JSON endpoints are declared here; the
 * binary ones (PUT /me/avatar raw image body, GET /users/:id/avatar bytes)
 * don't fit the JSON-in/JSON-out operation layer and stay hand-written in
 * routes.ts.
 *
 * `expose`: api only. A person's own name/picture is not something CLI/MCP
 * agents should read or change, so no cli/mcp surface.
 */
import { z } from '../../zod';

import { defineOperation, type OperationExpose } from '../../operation-contract';

const EXPOSE_API_ONLY: OperationExpose = { api: true, cli: false, mcp: false };

/** The signed-in user's profile (PersonAvatar = generated-look seed + photo version). */
export const meSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.enum(['admin', 'user']),
  /** The user has a password (admin-managed account): the client may offer "Change password". */
  has_password: z.boolean(),
  avatar: z.object({ seed: z.string(), image_version: z.number().nullable() }),
});

/**
 * GET /auth/me — the session probe every client (app LoginGate, CLI whoami)
 * calls: 200 with the caller's email, 401 when signed out. Open (it answers
 * 401 itself rather than through the auth middleware); in auth-disabled
 * local dev it answers dev@localhost.
 */
export const authMe = defineOperation({
  name: 'user_auth_me',
  description: 'Session probe: the email of the signed-in caller (session cookie or bearer token); 401 when signed out.',
  input: z.object({}),
  output: z.object({ email: z.string() }),
  method: 'GET',
  path: '/auth/me',
  kind: 'read',
  expose: EXPOSE_API_ONLY,
});

export const meGet = defineOperation({
  name: 'user_me_get',
  description: 'The signed-in user: id, email, name, role and avatar (PersonAvatar).',
  input: z.object({}),
  output: meSchema,
  method: 'GET',
  path: '/me',
  kind: 'read',
  expose: EXPOSE_API_ONLY,
});

export const meUpdate = defineOperation({
  name: 'user_me_update',
  description:
    'Update your display name and/or generated-avatar seed. A string avatar_seed picks that generated look (and drops any uploaded photo); null resets to the default.',
  input: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    avatar_seed: z.string().trim().min(1).max(64).nullable().optional(),
  }),
  output: meSchema,
  method: 'PATCH',
  path: '/me',
  kind: 'write',
  expose: EXPOSE_API_ONLY,
});

export const meAvatarRemove = defineOperation({
  name: 'user_me_avatar_remove',
  description: 'Remove your uploaded photo; your generated avatar shows again.',
  input: z.object({}),
  output: meSchema,
  method: 'DELETE',
  path: '/me/avatar',
  kind: 'destructive',
  expose: EXPOSE_API_ONLY,
});
