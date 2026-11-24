/**
 * AI key routes (post-gate): the caller's own key, provider detection and
 * model listing. All paths live under /ai and every operation is user-scoped:
 * there is no id to pass, and the key never appears in a response.
 *
 * Handlers parse, authorise and shape; key resolution/encryption is in
 * ./keys.ts, SQL in ./store.ts, provider details behind ./providers.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';

import {
  AI_KEY_REJECTED,
  AI_MODEL_UNKNOWN,
  AI_PROVIDER_UNKNOWN,
  aiCredentialsDelete,
  aiCredentialsGet,
  aiCredentialsSave,
  aiCredentialsTest,
  aiModelsList,
  aiProviderDetect,
  isAiProviderId,
  type AiProviderId,
} from '@shared/contracts/ai';

import { pool } from '../core/db';
import { implement, mountOperations, type AnyOperation } from '../core/operation';
import { secretBoxConfigured, SecretBoxUnavailable } from '../core/secret-box';
import { HttpError } from '../core/validate';
import { noStore, requireUserId } from '../user';
import { detectProvider } from './detect';
import { AiProviderError } from './errors';
import { aiKeyHttpError, resolveAiKey, sharedAiStatus, storeOwnKey } from './keys';
import { createProvider } from './providers';
import * as store from './store';
import type { AiModel } from './types';

/** Provider failures → HTTP: a refused key is the user's to fix; the rest is upstream. */
function providerHttpError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof AiProviderError) {
    switch (err.kind) {
      case 'auth':
        throw new HttpError(400, 'The AI provider did not accept this key. Check it and try again.', AI_KEY_REJECTED);
      case 'rate_limited':
        throw new HttpError(429, `The AI provider is rate limiting requests. Try again in a moment. (${err.message})`);
      default:
        throw new HttpError(502, `The AI provider request failed. Try again later. (${err.message})`);
    }
  }
  const detail = err instanceof Error ? err.message.replaceAll(/\s+/g, ' ').slice(0, 200) : String(err);
  throw new HttpError(502, `The AI provider request failed: ${detail}`);
}

/** The status shape every key operation answers with (never the secret). */
async function credentialStatus(userId: string) {
  const ownRow = await store.getCredential(pool, userId);
  const own =
    ownRow && isAiProviderId(ownRow.provider)
      ? { provider: ownRow.provider, model: ownRow.model, updated_at: ownRow.updated_at.toISOString() }
      : null;
  const shared = await sharedAiStatus(pool, userId);
  const effective = own ? ('own' as const) : shared.available ? ('shared' as const) : null;
  return { own, shared, effective };
}

async function listModelsOrFail(provider: AiProviderId, apiKey: string) {
  let models: AiModel[];
  try {
    models = await createProvider(provider, apiKey).listModels();
  } catch (err) {
    throw providerHttpError(err);
  }
  return models;
}

export const operations: readonly AnyOperation[] = [
  implement(aiCredentialsGet, async (c) => credentialStatus(requireUserId(c))),

  implement(aiCredentialsSave, async (c, input) => {
    const userId = requireUserId(c);
    const provider = input.provider ?? detectProvider(input.api_key);
    if (!provider) {
      throw new HttpError(
        400,
        'Could not tell which AI provider this key belongs to. Choose the provider and try again.',
        AI_PROVIDER_UNKNOWN,
      );
    }
    // Refuse before any upstream call when this server cannot store secrets.
    if (!secretBoxConfigured()) throw aiKeyHttpError('encryption_missing');
    // The provider's model list doubles as the key check.
    const models = await listModelsOrFail(provider, input.api_key);
    if (input.model && !models.some((model) => model.id === input.model)) {
      throw new HttpError(400, `The provider does not list the model "${input.model}". Choose one from the list.`, AI_MODEL_UNKNOWN);
    }
    try {
      await storeOwnKey(pool, userId, provider, input.api_key, input.model ?? null);
    } catch (err) {
      if (err instanceof SecretBoxUnavailable) throw aiKeyHttpError('encryption_missing');
      throw err;
    }
    return credentialStatus(userId);
  }),

  implement(aiCredentialsDelete, async (c) => ({ deleted: await store.deleteCredential(pool, requireUserId(c)) })),

  implement(aiCredentialsTest, async (c) => {
    const resolved = await resolveAiKey(pool, requireUserId(c));
    if (!resolved.ok) throw aiKeyHttpError(resolved.problem);
    const models = await listModelsOrFail(resolved.key.provider, resolved.key.apiKey);
    return { provider: resolved.key.provider, models: models.length };
  }),

  implement(aiProviderDetect, (_c, { api_key }) => ({ provider: detectProvider(api_key) })),

  implement(aiModelsList, async (c, input) => {
    let provider: AiProviderId;
    let apiKey: string;
    if (input.api_key) {
      const detected = input.provider ?? detectProvider(input.api_key);
      if (!detected) {
        throw new HttpError(400, 'Could not tell which AI provider this key belongs to. Choose the provider and try again.', AI_PROVIDER_UNKNOWN);
      }
      provider = detected;
      apiKey = input.api_key;
    } else {
      const resolved = await resolveAiKey(pool, requireUserId(c));
      if (!resolved.ok) throw aiKeyHttpError(resolved.problem);
      provider = input.provider ?? resolved.key.provider;
      apiKey = resolved.key.apiKey;
    }
    const models = await listModelsOrFail(provider, apiKey);
    return {
      provider,
      models: models.map((model) => ({ id: model.id, name: model.name, context_length: model.contextLength })),
    };
  }),
];

/** Identity first (401 before input validation), like the other user-scoped routers. */
const requireIdentity: MiddlewareHandler = async (c, next) => {
  requireUserId(c);
  await next();
};

/** Post-gate router; mount at /ai. */
export default mountOperations(new Hono(), operations, { basePath: '/ai', use: [requireIdentity, noStore] });
