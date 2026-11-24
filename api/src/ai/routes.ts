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
  AI_KEY_FORBIDDEN,
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
import { aiKeyHttpError, openOwnKey, resolveAiKey, sharedAiStatus, storeOwnKey, type ResolvedAiKey } from './keys';
import { createProvider, providerFor } from './providers';
import * as store from './store';
import type { AiModel } from './types';

const SK_SHAPED_KEY = /sk-[A-Za-z0-9_*-]{4,}/g;
/** Z.ai-shaped `<32 hex or 6+ digits>.<secret>` keys, including reformatted echoes. */
const DOTTED_KEY = /\b(?:[0-9a-f]{32}|\d{6,})\.[A-Za-z0-9_-]{8,}\b/gi;

/**
 * The key and every contiguous fragment of it (8+ chars, capped at 128) as
 * replacement targets, longest first. A provider that echoes a truncated or
 * reformatted key still gets the echoed part removed; keys longer than the cap
 * are covered by the exact whole-value replacement.
 */
function keyFragments(apiKey: string): string[] {
  const key = apiKey.trim();
  const parts = new Set<string>();
  const bounded = key.length > 128 ? key.slice(0, 128) : key;
  for (let length = bounded.length; length >= 8; length--) {
    for (let start = 0; start + length <= bounded.length; start++) parts.add(bounded.slice(start, start + length));
  }
  // Components of a dotted/segmented key (Z.ai id.secret, sk-ant-... parts).
  for (const part of key.split(/[.:_\-/]/)) if (part.length >= 8) parts.add(part);
  return [...parts].sort((a, b) => b.length - a.length);
}

/** Remove the key, its fragments and every documented key shape from log text. */
function redactSecrets(detail: string, apiKey: string): string {
  let out = detail;
  for (const fragment of keyFragments(apiKey)) out = out.replaceAll(fragment, '[redacted]');
  return out.replaceAll(SK_SHAPED_KEY, '[redacted]').replaceAll(DOTTED_KEY, '[redacted]');
}

/**
 * Provider text is for the server log only, and the key is removed before it
 * can reach a log line. Users get a fixed message per error kind: an upstream
 * body can carry account, quota or organization details (and, on some
 * providers, part of the key).
 */
function logProviderError(err: unknown, apiKey: string): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[ai] ${redactSecrets(detail, apiKey)}`);
}

/** Provider failures → HTTP: a refused key is the user's to fix; the rest is upstream. */
function providerHttpError(c: Context, err: unknown, apiKey: string): never {
  if (err instanceof HttpError) throw err;
  logProviderError(err, apiKey);
  if (err instanceof AiProviderError) {
    switch (err.kind) {
      case 'auth':
        throw new HttpError(400, 'The AI provider did not accept this key. Check it and try again.', AI_KEY_REJECTED);
      case 'forbidden':
        throw new HttpError(
          403,
          'The AI provider accepted this key, but the key is not allowed to do this. Check its permissions; OpenAI keys need Models Read to list models.',
          AI_KEY_FORBIDDEN,
        );
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

/** Run one provider call, turning every failure into the fixed HTTP answer. */
async function aiCall<T>(c: Context, apiKey: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw providerHttpError(c, err, apiKey);
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
    // fetched twice.
    const checked = await aiCall(c, input.api_key, () => createProvider(provider, input.api_key).verifyKey());
    if (input.model) {
      const models = checked ?? (await aiCall(c, input.api_key, () => createProvider(provider, input.api_key).listModels()));
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
    const checked = await aiCall(c, key.apiKey, () => providerFor(key).verifyKey());
    const models = checked ?? (await aiCall(c, key.apiKey, () => providerFor(key).listModels()));
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
      models = await aiCall(c, candidate, () => createProvider(detected, candidate).listModels());
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
      models = await aiCall(c, key.apiKey, () => providerFor(key).listModels());
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
