/**
 * AI key routes (post-gate): the caller's own key, provider detection and
 * model listing. All paths live under /ai and every operation is user-scoped:
 * there is no id to pass, and the key never appears in a response.
 *
 * Handlers parse, authorise and shape; key resolution/encryption is in
 * ./keys.ts, SQL in ./store.ts, provider details behind ./providers.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';

import {
  AI_KEY_REJECTED,
  AI_MODEL_UNKNOWN,
  AI_PROVIDER_MISMATCH,
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

/**
 * Provider text is for the server log only, and the key is removed before it
 * can reach a log line. Users get a fixed message per error kind: an upstream
 * body can carry account, quota or organization details (and, on some
 * providers, part of the key).
 */
function logProviderError(err: unknown, apiKey: string): void {
  const detail = err instanceof Error ? err.message : String(err);
  const redacted = detail.replaceAll(apiKey, '[redacted]').replaceAll(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  console.error(`[ai] ${redacted}`);
}

/** Provider failures → HTTP: a refused key is the user's to fix; the rest is upstream. */
function providerHttpError(c: Context, err: unknown, apiKey: string): never {
  if (err instanceof HttpError) throw err;
  logProviderError(err, apiKey);
  if (err instanceof AiProviderError) {
    switch (err.kind) {
      case 'auth':
        throw new HttpError(400, 'The AI provider did not accept this key. Check it and try again.', AI_KEY_REJECTED);
      case 'rate_limited':
        if (err.retryAfterMs !== null) {
          c.header('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
        }
        throw new HttpError(429, 'The AI provider is rate limiting requests. Try again in a moment.');
      case 'transient':
        throw new HttpError(502, 'The AI provider is unavailable right now. Try again later.');
      case 'permanent':
        throw new HttpError(502, 'The AI provider rejected the request. Try again later.');
      case 'bad_response':
        throw new HttpError(502, 'The AI provider answered something unexpected. Try again later.');
    }
  }
  throw new HttpError(502, 'The AI provider request failed. Try again later.');
}

/** The status shape every key operation answers with (never the secret). */
async function credentialStatus(userId: string) {
  const ownRow = await store.getCredential(pool, userId);
  const ownProvider = ownRow && isAiProviderId(ownRow.provider) ? ownRow.provider : null;
  const own = ownProvider ? { provider: ownProvider, model: ownRow!.model, updated_at: ownRow!.updated_at.toISOString() } : null;
  const shared = await sharedAiStatus(pool, userId);
  // A row with an unknown provider blocks the shared fallback in resolveAiKey
  // (unreadable), so status must not advertise 'shared' for it either.
  const effective = ownProvider ? ('own' as const) : ownRow ? null : shared.available ? ('shared' as const) : null;
  return { own, shared, effective };
}

async function listModelsOrFail(c: Context, provider: AiProviderId, apiKey: string) {
  let models: AiModel[];
  try {
    models = await createProvider(provider, apiKey).listModels();
  } catch (err) {
    throw providerHttpError(c, err, apiKey);
  }
  return models;
}

async function verifyKeyOrFail(c: Context, provider: AiProviderId, apiKey: string): Promise<void> {
  try {
    await createProvider(provider, apiKey).verifyKey();
  } catch (err) {
    throw providerHttpError(c, err, apiKey);
  }
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
    // An authenticated call proves the key. Listing models is not enough: on
    // OpenRouter that list is public, so a junk key would pass.
    await verifyKeyOrFail(c, provider, input.api_key);
    if (input.model) {
      const models = await listModelsOrFail(c, provider, input.api_key);
      if (!models.some((model) => model.id === input.model)) {
        throw new HttpError(400, `The provider does not list the model "${input.model}". Choose one from the list.`, AI_MODEL_UNKNOWN);
      }
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
    await verifyKeyOrFail(c, resolved.key.provider, resolved.key.apiKey);
    const models = await listModelsOrFail(c, resolved.key.provider, resolved.key.apiKey);
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
      if (input.provider && input.provider !== resolved.key.provider) {
        throw new HttpError(
          400,
          'The saved AI key belongs to a different provider. Save a key for this provider, or list the saved one’s models.',
          AI_PROVIDER_MISMATCH,
        );
      }
      provider = resolved.key.provider;
      apiKey = resolved.key.apiKey;
    }
    const models = await listModelsOrFail(c, provider, apiKey);
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
