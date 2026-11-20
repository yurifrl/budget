/**
 * The caller's OWN bank-provider key set (client id + client secret), one per
 * user and provider. User-scoped: every operation acts on the signed-in
 * user's row only; there is no id to pass and no budget involved.
 *
 * Error codes (body `{ error, code }`):
 *   invalid_credentials       400  the provider refused the pair (save)
 *   credentials_key_missing   503  the installation has no encryption key configured
 * Related, on the connect flow (connections_connect_token / _items_register):
 *   own_keys_required         403  the caller has no own key set and may not
 *                                  use the installation's shared keys
 */
import { z } from '../../zod';

import { defineOperation, EXPOSE_NO_MCP } from '../../operation-contract';
import { connectionCredentialsSchema, connectionDeletedSchema } from './outputs';

const API_ONLY = { api: true, cli: false, mcp: false } as const;

/** Error codes of the own-keys feature, shared with clients. */
export const OWN_KEYS_REQUIRED = 'own_keys_required';
export const INVALID_CREDENTIALS = 'invalid_credentials';
export const CREDENTIALS_KEY_MISSING = 'credentials_key_missing';
export const CONNECTION_PAUSED = 'connection_paused';
/** Register: none of the caller's key sets reaches the item (409). */
export const ITEM_NOT_REACHABLE = 'item_not_reachable';

const provider = z.string().min(1).default('pluggy').describe('Bank provider the key set belongs to (default pluggy)');

export const connectionsCredentialsGet = defineOperation({
  name: 'connections_credentials_get',
  description:
    "Status of the current user's own bank-provider key set: the client id and whether a secret is stored. The secret itself is never returned. clientId and updatedAt are null (hasSecret false) when none is saved.",
  input: z.object({ provider }),
  output: connectionCredentialsSchema,
  method: 'GET',
  path: '/connections/credentials',
  kind: 'read',
  expose: EXPOSE_NO_MCP,
});

export const connectionsCredentialsSave = defineOperation({
  name: 'connections_credentials_save',
  description:
    "Save or replace the current user's own bank-provider key set (client id + client secret). The pair is checked with the provider first: 400 invalid_credentials if it is refused. The secret is stored encrypted and never returned; the answer is the same status connections_credentials_get gives. 503 credentials_key_missing if the installation has no encryption key.",
  input: z.object({
    provider,
    clientId: z.string().trim().min(1).max(200),
    clientSecret: z.string().trim().min(1).max(500),
  }),
  output: connectionCredentialsSchema,
  method: 'PUT',
  path: '/connections/credentials',
  kind: 'write',
  // A secret on a command line lands in shell history; in an MCP call, in a model's context.
  expose: API_ONLY,
});

export const connectionsCredentialsDelete = defineOperation({
  name: 'connections_credentials_delete',
  description:
    "Delete the current user's own bank-provider key set. Idempotent. Bank connections created with it are paused (not deleted) until the same key set is saved again.",
  input: z.object({ provider }),
  output: connectionDeletedSchema,
  method: 'DELETE',
  path: '/connections/credentials',
  query: ['provider'],
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});
