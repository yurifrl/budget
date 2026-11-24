/**
 * Provider detection from the key's shape. A guess, never a validation: all
 * five providers verify the key themselves on save (`listModels`), and the
 * caller may always choose a provider explicitly — save overrides this guess.
 *
 * Rules, in order:
 *   sk-or-...            OpenRouter  (sk-or-v1- prefix)
 *   sk-ant-...           Anthropic
 *   sk-proj- / sk-svcacct- / sk-admin-   OpenAI (project/service/admin keys)
 *   sk-<32 hex>          DeepSeek (its keys are sk- + 32 hex)
 *   sk-...               OpenAI (legacy keys; anything sk-shaped left)
 *   <id>.<secret>        Z.ai (Zhipu: numeric id, dot, secret)
 * Anything else: unknown (null).
 */
import type { AiProviderId } from '@shared/contracts/ai';

const RULES: ReadonlyArray<readonly [AiProviderId, RegExp]> = [
  ['openrouter', /^sk-or-(v1-)?[A-Za-z0-9_-]{16,}$/],
  ['anthropic', /^sk-ant-[A-Za-z0-9_-]{16,}$/],
  ['openai', /^sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{16,}$/],
  ['deepseek', /^sk-[0-9a-f]{32}$/i],
  ['openai', /^sk-[A-Za-z0-9_-]{20,}$/],
  ['zai', /^\d{6,}\.[A-Za-z0-9_-]{6,}$/],
];

export function detectProvider(apiKey: string): AiProviderId | null {
  const key = apiKey.trim();
  for (const [provider, pattern] of RULES) if (pattern.test(key)) return provider;
  return null;
}
