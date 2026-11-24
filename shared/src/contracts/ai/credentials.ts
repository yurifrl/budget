/**
 * The caller's AI key and the provider calls that support choosing one.
 * User-scoped: every operation acts on the signed-in user's credential; there
 * is no id to pass and no budget involved. A user has at most one AI key (own
 * wins over the installation's shared key); saving replaces it.
 *
 * Error codes (body `{ error, code }`):
 *   ai_key_rejected             400  the provider refused the key
 *   ai_provider_unknown         400  no provider given and none could be detected
 *   ai_model_unknown            400  the chosen model is not in the provider's list
 *   own_ai_key_required         403  no own key and the shared key is not available
 *   ai_key_encryption_missing   503  the installation has no encryption key configured
 *   ai_key_unreadable           503  the stored secret cannot be decrypted here
 *   ai_shared_key_missing       503  feature on, but the server has no shared AI key
 * Upstream failures are 502 (`upstream_error`); a provider 429 is a 429.
 *
 * `ai_provider_detect` and `ai_models_list` are POSTs even though they change
 * nothing: their input may carry an API key, and a secret never travels in a
 * URL (query strings are logged). They are API-only for the same reason.
 */
import { z } from '../../zod';

import { defineOperation, EXPOSE_NO_MCP } from '../../operation-contract';
import {
  aiCredentialDeletedSchema,
  aiCredentialStatusSchema,
  aiModelsSchema,
  aiProviderDetectedSchema,
  aiProviderSchema,
  aiTestResultSchema,
} from './outputs';

/** API only: the body carries a secret (`api_provider_detect`, save, models). */
const API_ONLY = { api: true, cli: false, mcp: false } as const;

export const AI_KEY_REQUIRED = 'own_ai_key_required';
export const AI_KEY_REJECTED = 'ai_key_rejected';
export const AI_PROVIDER_UNKNOWN = 'ai_provider_unknown';
export const AI_MODEL_UNKNOWN = 'ai_model_unknown';
export const AI_ENCRYPTION_MISSING = 'ai_key_encryption_missing';
export const AI_KEY_UNREADABLE = 'ai_key_unreadable';
export const AI_SHARED_KEY_MISSING = 'ai_shared_key_missing';

const apiKey = z.string().trim().min(8).max(500).describe('The provider API key. Stored encrypted; never returned.');
const model = z.string().trim().min(1).max(200).describe('A model id from the provider’s model list.');

export const aiCredentialsGet = defineOperation({
  name: 'ai_credentials_get',
  description:
    "Status of the caller's AI key: their own credential (provider and chosen model; never the key), whether the installation's shared key is available to them, and which source a categorization run would use (own wins).",
  input: z.object({}),
  output: aiCredentialStatusSchema,
  method: 'GET',
  path: '/ai/credentials',
  kind: 'read',
  expose: EXPOSE_NO_MCP,
});

export const aiCredentialsSave = defineOperation({
  name: 'ai_credentials_save',
  description:
    "Save or replace the caller's AI key. The provider is detected from the key when omitted. The key is checked with the provider (model list) before it is stored encrypted; a refused key is 400 ai_key_rejected. With `model`, it must be one of the provider's models (400 ai_model_unknown). The answer is the same status ai_credentials_get gives; the key is never returned.",
  input: z.object({ api_key: apiKey, provider: aiProviderSchema.optional(), model: model.optional() }),
  output: aiCredentialStatusSchema,
  method: 'PUT',
  path: '/ai/credentials',
  kind: 'write',
  expose: API_ONLY,
});

export const aiCredentialsDelete = defineOperation({
  name: 'ai_credentials_delete',
  description:
    "Delete the caller's own AI key. Idempotent: `deleted` says whether a credential was there. Categorization then falls back to the installation's shared key when the feature allows it.",
  input: z.object({}),
  output: aiCredentialDeletedSchema,
  method: 'DELETE',
  path: '/ai/credentials',
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});

export const aiCredentialsTest = defineOperation({
  name: 'ai_credentials_test',
  description:
    'Check the AI key a categorization run would use (own key first, else the shared one) by listing its provider’s models. 400 ai_key_rejected when the provider refuses the key. Never returns the key.',
  input: z.object({}),
  output: aiTestResultSchema,
  method: 'GET',
  path: '/ai/credentials/test',
  kind: 'read',
  expose: EXPOSE_NO_MCP,
});

export const aiProviderDetect = defineOperation({
  name: 'ai_provider_detect',
  description:
    'Guess the AI provider from the shape of a key, so the UI can preselect it. Nonsense/local only: no provider is called. `provider` is null when the shape is unknown; the caller may then choose any provider (and save overrides the guess). POST so the key never travels in a URL.',
  input: z.object({ api_key: apiKey }),
  output: aiProviderDetectedSchema,
  method: 'POST',
  path: '/ai/provider-detect',
  kind: 'write',
  expose: API_ONLY,
});

export const aiModelsList = defineOperation({
  name: 'ai_models_list',
  description:
    "List the models of an AI provider, to pick the one categorization uses. Without `api_key`, lists the saved credential's provider (own key first, else the shared one); `provider` may override the saved provider. With `api_key`, lists that candidate key's models before it is saved, with the provider detected when omitted (400 ai_provider_unknown). POST so the key never travels in a URL.",
  input: z.object({ api_key: apiKey.optional(), provider: aiProviderSchema.optional() }),
  output: aiModelsSchema,
  method: 'POST',
  path: '/ai/models',
  kind: 'write',
  expose: API_ONLY,
});
