/**
 * AI provider registry — provider id → adapter factory.
 *
 * One map, sourced from the five adapters. Everything else reaches adapters
 * only through `providerFor`, which consumes an opaque `ResolvedAiKey` created
 * by key resolution. New provider = new adapter folder + one line here + one
 * value in shared/src/contracts/ai/outputs.ts.
 */
import type { AiProviderId } from '@shared/contracts/ai';

import type { FetchLike } from '../http';
import type { AiModel, AiProvider } from '../types';
import { AnthropicProvider } from './anthropic';
import { isOpenAiChatModel, OpenAiCompatibleProvider } from './openai-compatible';

/**
 * Test-only factory options: only the provider table sees them;
 * `providerFor` never forwards caller options, so a stored key cannot be
 * pointed at another host.
 */
export type ProviderOptions = {
  /** Override the provider's API origin (tests point this at a stub server). */
  baseUrl?: string;
  /** Override fetch (tests). */
  fetch?: FetchLike;
};

export type ProviderEntry = {
  /** Default API origin, without a trailing slash. */
  baseUrl: string;
  create: (apiKey: string, options?: ProviderOptions) => AiProvider;
};

/**
 * Z.ai documents no model-list endpoint (docs.z.ai/openapi.json, 2026-11-24).
 * This is the documented chat-model suggestion list: the text request enum
 * (glm-5.3 … glm-4.6) plus the FLASH/FLASHX/LEGAL variants named in the
 * pricing table and chat examples. Vision families are separate and not
 * listed. Context lengths are not published per model; null means the provider
 * did not report one. A caller may save a model id outside this list: it is a
 * suggestion, since the real list cannot be fetched.
 */
const ZAI_MODELS: readonly AiModel[] = [
  'glm-4.6',
  'glm-4.7',
  'glm-5',
  'glm-5.1',
  'glm-5.2',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.3-flashx',
  'glm-5.3-flashx-legal',
].map((id) => ({ id, name: id, contextLength: null }));

/**
 * Cheapest documented model for a key check: GLM-5.3-Flash at $0.15/M input
 * and $0.50/M output (docs.z.ai/guides/overview/pricing). A "ping" with
 * max_tokens 1 costs well under $0.00001. It is a member of ZAI_MODELS.
 */
const ZAI_KEY_CHECK_MODEL = 'glm-5.3-flash';

const entries: Record<AiProviderId, ProviderEntry> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    create: (apiKey, options) =>
      new OpenAiCompatibleProvider(
        {
          id: 'openrouter',
          label: 'OpenRouter',
          baseUrl: options?.baseUrl ?? entries.openrouter.baseUrl,
          // /models is public; /key authenticates the key.
          keyCheck: () => ({ path: '/key' }),
          structured: 'json_schema',
          tokenParam: 'max_tokens',
        },
        apiKey,
        options?.fetch,
      ),
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    create: (apiKey, options) => new AnthropicProvider(apiKey, options?.baseUrl ?? entries.anthropic.baseUrl, options?.fetch),
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    create: (apiKey, options) =>
      new OpenAiCompatibleProvider(
        {
          id: 'openai',
          label: 'OpenAI',
          baseUrl: options?.baseUrl ?? entries.openai.baseUrl,
          // OpenAI documents 401 when the key lacks the endpoint's scope, so a
          // chat-only restricted key cannot verify and is not saved.
          keyCheck: () => ({ path: '/models' }),
          structured: 'json_schema',
          tokenParam: 'max_completion_tokens',
          filterModel: isOpenAiChatModel,
        },
        apiKey,
        options?.fetch,
      ),
  },
  zai: {
    baseUrl: 'https://api.z.ai/api/paas/v4',
    create: (apiKey, options) =>
      new OpenAiCompatibleProvider(
        {
          id: 'zai',
          label: 'Z.ai',
          baseUrl: options?.baseUrl ?? entries.zai.baseUrl,
          // No documented model-list endpoint. The documented chat completion
          // is the cheapest call that proves the key; the user's chosen model
          // is used when there is one, otherwise the cheapest documented model.
          keyCheck: (model) => ({
            path: '/chat/completions',
            method: 'POST',
            body: {
              model: model ?? ZAI_KEY_CHECK_MODEL,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
            },
          }),
          staticModels: ZAI_MODELS,
          structured: 'json_object',
          tokenParam: 'max_tokens',
          // Its OpenAPI documents `tool_choice` only as "auto".
          toolChoiceNone: false,
        },
        apiKey,
        options?.fetch,
      ),
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    create: (apiKey, options) =>
      new OpenAiCompatibleProvider(
        {
          id: 'deepseek',
          label: 'DeepSeek',
          baseUrl: options?.baseUrl ?? entries.deepseek.baseUrl,
          keyCheck: () => ({ path: '/models' }),
          structured: 'json_object',
          tokenParam: 'max_tokens',
        },
        apiKey,
        options?.fetch,
      ),
  },
};

/**
 * The built-in table. Deep import for tests only: entries take a raw key and
 * test options, never a ResolvedAiKey, so this cannot redirect a stored key.
 * `providerFor` remains the public factory and takes no options.
 */
export const builtinProviders: Readonly<Record<AiProviderId, ProviderEntry>> = entries;

/** Test seam: swap the provider table (null restores the built-in registry). */
let table: Record<AiProviderId, ProviderEntry> = entries;

export function setProviders(map: Record<AiProviderId, ProviderEntry> | null): void {
  table = map ?? entries;
}

const RESOLVED_KEY_TOKEN: unique symbol = Symbol('ResolvedAiKey');

type ResolvedKeyFields = {
  source: 'own' | 'shared';
  provider: AiProviderId;
  model: string | null;
  apiKey: string;
  updatedAt: string | null;
};

/**
 * The key a run would use, decrypted. Only `resolveAiKey` (through the
 * module-internal factory) can produce one: the constructor requires a token
 * private to this module, the secret has no accessor, and a structural
 * `{ provider, apiKey }` object is not a `ResolvedAiKey`. The public fields
 * are frozen so a key cannot be re-pointed at another provider; `adapter()`
 * binds the secret to its own provider's host and takes no options.
 */
export class ResolvedAiKey {
  readonly source: 'own' | 'shared';
  readonly provider: AiProviderId;
  readonly model: string | null;
  readonly updatedAt: string | null;
  readonly #apiKey: string;

  constructor(token: typeof RESOLVED_KEY_TOKEN, fields: ResolvedKeyFields) {
    if (token !== RESOLVED_KEY_TOKEN) throw new TypeError('ResolvedAiKey must come from resolveAiKey');
    this.source = fields.source;
    this.provider = fields.provider;
    this.model = fields.model;
    this.updatedAt = fields.updatedAt;
    this.#apiKey = fields.apiKey;
    // `readonly` is compile-time only; a re-pointed provider would send the
    // secret to another host. Freeze the public fields for the runtime too.
    Object.freeze(this);
  }

  /** The adapter for exactly this provider and secret; never caller options. */
  adapter(): AiProvider {
    return table[this.provider].create(this.#apiKey);
  }
}

/** Internal: key resolution and the candidate checks in this feature only. */
export function makeResolvedAiKey(fields: ResolvedKeyFields): ResolvedAiKey {
  return new ResolvedAiKey(RESOLVED_KEY_TOKEN, fields);
}

/**
 * The adapter for a resolved key. Takes the whole resolution, never a
 * (provider, key) pair, and takes no options, so a caller cannot send a
 * stored key to another provider's host. This is the only provider factory
 * the categorizer gets.
 */
export function providerFor(resolved: ResolvedAiKey): AiProvider {
  if (!(resolved instanceof ResolvedAiKey)) throw new TypeError('providerFor requires a key from resolveAiKey');
  return resolved.adapter();
}

/** The configured API origin of a provider (boot diagnostics, error hints). */
export function providerBaseUrl(id: AiProviderId): string {
  return table[id].baseUrl;
}
