/**
 * Output (response) schemas of the AI key operations. The provider list is
 * closed in code: a new provider is a new adapter AND a new value here, never
 * a database write. No schema below has a field for the API key itself.
 */
import { z } from '../../zod';

/**
 * Providers the installation can talk to. `zai` is Z.ai (Zhipu GLM), `deepseek`
 * DeepSeek; both speak an OpenAI-compatible chat API. The value is also the
 * prefix of the provider's adapter folder (`api/src/ai/providers/<id>`).
 * Z.ai keys have no documented shape, so detection never returns `zai`; the
 * caller offers it as an explicit choice.
 */
export const AI_PROVIDERS = ['openrouter', 'anthropic', 'openai', 'zai', 'deepseek'] as const;
export const aiProviderSchema = z.enum(AI_PROVIDERS);
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export const isAiProviderId = (value: string): value is AiProviderId => (AI_PROVIDERS as readonly string[]).includes(value);

/** The caller's own credential, as shown back to them: never the key. */
export const aiOwnCredentialSchema = z.object({
  provider: aiProviderSchema,
  /** The model the caller picked; null until they pick one. */
  model: z.string().nullable(),
  updated_at: z.string(),
});

/** The installation's shared key as far as this caller may use it. */
export const aiSharedCredentialSchema = z.object({
  /** True when feature 'shared-ai-key' is on for the caller AND the shared key and its model are configured. */
  available: z.boolean(),
  provider: aiProviderSchema.nullable(),
  model: z.string().nullable(),
});

/**
 * Where the key a categorization run would use comes from: the caller's own
 * credential, else the installation's shared key, else none (`null`).
 */
export const aiKeySourceSchema = z.enum(['own', 'shared']);

export const aiCredentialStatusSchema = z.object({
  own: aiOwnCredentialSchema.nullable(),
  shared: aiSharedCredentialSchema,
  effective: aiKeySourceSchema.nullable(),
});

/**
 * Why a key resolution failed. Kept here (not only in the API) because the
 * Categorize page's status carries it to the client to choose its empty state.
 */
export const AI_KEY_PROBLEMS = [
  'own_key_required',
  'shared_key_missing',
  'shared_model_missing',
  'encryption_missing',
  'unreadable',
] as const;
export const aiKeyProblemSchema = z.enum(AI_KEY_PROBLEMS);
export type AiKeyProblemId = (typeof AI_KEY_PROBLEMS)[number];

export const aiCredentialDeletedSchema = z.object({ deleted: z.boolean() });

/** Detection is a best guess from the key's shape; null = unknown, the caller picks. */
export const aiProviderDetectedSchema = z.object({ provider: aiProviderSchema.nullable() });

export const aiModelSchema = z.object({
  id: z.string(),
  /** Human label from the provider; falls back to `id`. */
  name: z.string(),
  /** Context window in tokens when the provider reports it, else null. */
  context_length: z.number().int().nullable(),
});

export const aiModelsSchema = z.object({
  provider: aiProviderSchema,
  models: z.array(aiModelSchema),
});

/** Result of checking a saved key with its provider (models listed = key accepted). */
export const aiTestResultSchema = z.object({
  provider: aiProviderSchema,
  models: z.number().int(),
});
