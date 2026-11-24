/**
 * Provider detection from the key's shape. A guess, never a validation: the
 * provider verifies the key itself on save (`verifyKey`), and the caller may
 * always choose a provider explicitly — save overrides this guess.
 *
 * Rules, in order:
 *   sk-or-...            OpenRouter  (sk-or-v1- prefix)
 *   sk-ant-...           Anthropic
 *   sk-proj- / sk-svcacct- / sk-admin-   OpenAI (project/service/admin keys)
 *   sk-<32 hex>          DeepSeek (its keys are sk- + 32 hex)
 *   sk-...               OpenAI (legacy keys; anything sk-shaped left)
 *
 * Z.ai (Zhipu) is absent on purpose: its documentation does not state a key
 * shape, and public reports disagree on the id before the dot, so a Z.ai key
 * cannot be guessed safely. The caller picks `zai` (and a shared Z.ai key
 * needs AI_SHARED_PROVIDER=zai). Anything else: unknown (null).
 */
import type { AiProviderId } from '@shared/contracts/ai';

const RULES: ReadonlyArray<readonly [AiProviderId, RegExp]> = [
  ['openrouter', /^sk-or-(v1-)?[A-Za-z0-9_-]{16,}$/],
  ['anthropic', /^sk-ant-[A-Za-z0-9_-]{16,}$/],
  ['openai', /^sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{16,}$/],
  ['deepseek', /^sk-[0-9a-f]{32}$/i],
  ['openai', /^sk-[A-Za-z0-9_-]{20,}$/],
];

export function detectProvider(apiKey: string): AiProviderId | null {
  const key = apiKey.trim();
  for (const [provider, pattern] of RULES) if (pattern.test(key)) return provider;
  return null;
}
