/**
 * OAuth grant management contracts (pure data — zod + core contract types only).
 * A user sees and revokes the apps (MCP clients, CLI) connected to THEIR account.
 * Handlers: ../grants-routes.ts. `expose`: api + cli, not mcp — an agent should
 * not manage its own (or its siblings') access.
 */
import { z } from '../../zod';

import { defineOperation, EXPOSE_NO_MCP } from '../../operation-contract';

export const oauthGrantsList = defineOperation({
  name: 'oauth_grants_list',
  description:
    'List the apps (OAuth grants) connected to your account: client name, scopes, created, last used (latest token refresh) and expiry. Active grants only.',
  input: z.object({}),
  method: 'GET',
  path: '/oauth/grants',
  kind: 'read',
  expose: EXPOSE_NO_MCP,
});

export const oauthGrantsRevoke = defineOperation({
  name: 'oauth_grants_revoke',
  description: "Revoke a connected app's access (its access and refresh tokens stop working). Only your own grants.",
  input: z.object({ id: z.string().uuid() }),
  method: 'DELETE',
  path: '/oauth/grants/:id',
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});
