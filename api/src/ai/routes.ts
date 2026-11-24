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
import { secretBoxConfigured, SecretBoxOpenError, SecretBoxUnavailable } from '../core/secret-box';
import { HttpError } from '../core/validate';
import { noStore, requireUserId } from '../user';
import { detectProvider } from './detect';
import { AiProviderError } from './errors';
import { aiKeyHttpError, openOwnKey, resolveAiKey, sharedAiStatus, storeOwnKey } from './keys';
import { makeResolvedAiKey, providerFor, type ResolvedAiKey } from './providers';
import * as store from './store';
import type { AiModel } from './types';

/**
 * Provider text stays out of logs: it can contain account, quota or
 * organization details, and any signed-in user can trigger these calls.
 * Provider/kind/status are enough to diagnose; the categorizer redacts any
 * text it records with the exported `redactSecrets`.
 */
function logProviderError(err: unknown): void {
  if (err instanceof AiProviderError) {
    console.error(`[ai] provider failure provider=${err.provider ?? 'unknown'} kind=${err.kind} status=${err.status ?? 'none'}`);
    return;
  }
  console.error('[ai] provider failure provider=unknown kind=unknown status=none');
}

/** Provider failures → HTTP: a refused key is the user's to fix; the rest is upstream. */
function providerHttpError(c: Context, err: unknown): never {
  if (err instanceof HttpError) throw err;
  logProviderError(err);
  if (err instanceof AiProviderError) {
    switch (err.kind) {
      case 'auth':
        throw new HttpError(400, 'The AI provider did not accept this key. Check it and try again.', AI_KEY_REJECTED);
      case 'rate_limited':
        if (err.retryAfterMs !== null) {
          c.header('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
        }
        throw new HttpError(429, 'The AI provider is rate limiting requests. Try again in a moment.');
      case 'timeout':
        throw new HttpError(502, 'The AI provider took too long to answer. Try again later.');
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

/** Run one provider call, turning every failure into the fixed HTTP answer. */
async function aiCall<T>(c: Context, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw providerHttpError(c, err);
  }
}

/** True when the stored secret still opens on this server (master key unchanged). */
async function ownKeyUsable(row: store.AiCredentialRow): Promise<boolean> {
  try {
    await openOwnKey(row);
    return true;
  } catch (err) {
    if (err instanceof SecretBoxOpenError || err instanceof SecretBoxUnavailable) return false;
    throw err;
  }
}

/** The status shape every key operation answers with (never the secret). */
async function credentialStatus(userId: string) {
  const ownRow = await store.getCredential(pool, userId);
  const ownProvider = ownRow && isAiProviderId(ownRow.provider) ? ownRow.provider : null;
  const own = ownProvider ? { provider: ownProvider, model: ownRow!.model, updated_at: ownRow!.updated_at.toISOString() } : null;
  const shared = await sharedAiStatus(pool, userId);
  // `effective` must match resolveAiKey: a row with an unknown provider, or a
  // secret that no longer opens, blocks the shared fallback (unreadable).
  const effective =
    ownProvider && ownRow && (await ownKeyUsable(ownRow)) ? ('own' as const) : !ownRow && shared.available ? ('shared' as const) : null;
  return { own, shared, effective };
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
    // OpenRouter that list is public, so a junk key would pass. Adapters that
    // checked via their (authenticated) model list return it, so it is not
    // fetched twice. Z.ai has no model-list endpoint: its list is a
    // suggestion, so a typed id outside it is accepted after the check.
    const candidate = makeResolvedAiKey({ source: 'own', provider, model: input.model ?? null, apiKey: input.api_key, updatedAt: null });
    const adapter = providerFor(candidate);
    const checked = await aiCall(c, () => adapter.verifyKey(input.model));
    if (input.model && provider !== 'zai') {
      const models = checked ?? (await aiCall(c, () => adapter.listModels()));
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
    const key: ResolvedAiKey = resolved.key;
    const adapter = providerFor(key);
    // Z.ai's check is a chat call: use the saved model, not the fallback.
    const checked = await aiCall(c, () => adapter.verifyKey(key.model ?? undefined));
    const models = checked ?? (await aiCall(c, () => adapter.listModels()));
    return { provider: key.provider, models: models.length };
  }),

  implement(aiProviderDetect, (_c, { api_key }) => ({ provider: detectProvider(api_key) })),

  implement(aiModelsList, async (c, input) => {
    let models: AiModel[];
    let provider: AiProviderId;
    if (input.api_key) {
      const candidate = input.api_key;
      const detected = input.provider ?? detectProvider(candidate);
      if (!detected) {
        throw new HttpError(400, 'Could not tell which AI provider this key belongs to. Choose the provider and try again.', AI_PROVIDER_UNKNOWN);
      }
      provider = detected;
      const resolvedCandidate = makeResolvedAiKey({
        source: 'own',
        provider: detected,
        model: null,
        apiKey: candidate,
        updatedAt: null,
      });
      const adapter = providerFor(resolvedCandidate);
      const checked = await aiCall(c, () => adapter.verifyKey());
      models = checked ?? (await aiCall(c, () => adapter.listModels()));
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
      const key: ResolvedAiKey = resolved.key;
      provider = key.provider;
      const adapter = providerFor(key);
      // Z.ai's check is a chat call: use the saved model, not the fallback.
      const checked = await aiCall(c, () => adapter.verifyKey(key.model ?? undefined));
      models = checked ?? (await aiCall(c, () => adapter.listModels()));
    }
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
