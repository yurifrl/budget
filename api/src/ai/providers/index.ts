/**
 * AI provider registry — provider id → adapter factory.
 *
 * One map, sourced from the five adapters. Everything else resolves adapters
 * only through this module. New provider = new adapter folder + one line here +
 * one value in shared/src/contracts/ai/outputs.ts.
 */
import type { AiProviderId } from '@shared/contracts/ai';

import type { FetchLike } from '../http';
import type { ResolvedAiKey } from '../keys';
import type { AiModel, AiProvider } from '../types';
import { AnthropicProvider } from './anthropic';
import { isOpenAiChatModel, OpenAiCompatibleProvider } from './openai-compatible';

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
 * Z.ai's OpenAPI spec documents no model-list endpoint (checked against
 * docs.z.ai/openapi.json, 2026-11-24), so the list is the chat models that
 * spec names: the text families in ChatCompletionTextRequest and the vision
 * families in ChatCompletionVisionRequest. Context lengths are not published
 * per model; null means "provider did not report it".
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
          keyCheck: { path: '/key' },
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
          // /models needs api.model.read; a chat-only restricted key gets 403,
          // which still proves the key authenticated.
          keyCheck: { path: '/models' },
          keyCheckAcceptsForbidden: true,
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
          // No documented model-list endpoint; the tokenizer is documented,
          // authenticated and spends no inference tokens.
          keyCheck: {
            path: '/tokenizer',
            method: 'POST',
            body: { model: 'glm-4.6', messages: [{ role: 'user', content: 'ping' }] },
          },
          staticModels: ZAI_MODELS,
          structured: 'json_object',
          tokenParam: 'max_tokens',
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
          keyCheck: { path: '/models' },
          structured: 'json_object',
          tokenParam: 'max_tokens',
        },
        apiKey,
        options?.fetch,
      ),
  },
};

/** Test seam: swap the provider table (null restores the built-in registry). */
let table: Record<AiProviderId, ProviderEntry> = entries;

export function setProviders(map: Record<AiProviderId, ProviderEntry> | null): void {
  table = map ?? entries;
}

/** The adapter for `id` on this key. The caller has already validated `id`. */
export function createProvider(id: AiProviderId, apiKey: string, options?: ProviderOptions): AiProvider {
  return table[id].create(apiKey, options);
}

/**
 * The adapter for a resolved key. Takes the whole resolution, never a
 * (provider, key) pair, so a caller cannot send a stored key to another
 * provider's host. This is the only helper the categorizer should use.
 */
export function providerFor(resolved: ResolvedAiKey, options?: ProviderOptions): AiProvider {
  return createProvider(resolved.provider, resolved.apiKey, options);
}

/** The configured API origin of a provider (boot diagnostics, error hints). */
export function providerBaseUrl(id: AiProviderId): string {
  return table[id].baseUrl;
}
