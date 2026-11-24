/**
 * AI provider registry — provider id → adapter factory.
 *
 * One map, sourced from the five adapters. Everything else resolves adapters
 * only through this module. New provider = new adapter folder + one line here +
 * one value in shared/src/contracts/ai/outputs.ts.
 */
import type { AiProviderId } from '@shared/contracts/ai';

import type { FetchLike } from '../http';
import type { AiProvider } from '../types';
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
          keyCheckPath: '/key',
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
          keyCheckPath: '/models',
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
          keyCheckPath: '/models',
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
          keyCheckPath: '/models',
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

/** The configured API origin of a provider (boot diagnostics, error hints). */
export function providerBaseUrl(id: AiProviderId): string {
  return table[id].baseUrl;
}
