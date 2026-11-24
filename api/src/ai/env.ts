/**
 * AI configuration handed over by the entrypoints (features never read
 * `process.env`). Only the installation's SHARED key lives here; a user's own
 * key is in the database (public.ai_credentials), sealed by core/secret-box.
 *
 *   AI_SHARED_API_KEY   the installation's AI key. Empty/unset = no shared key.
 *   AI_SHARED_PROVIDER  provider id for that key; when empty it is detected
 *                       from the key's shape. An unknown value means the shared
 *                       key is misconfigured and is treated as absent.
 *   AI_SHARED_MODEL     default model id for the shared key. The admin setting
 *                       `app_settings.aiSharedModel` overrides it at read time
 *                       (see ./settings.ts), so a model can change without a
 *                       redeploy.
 */
import { isAiProviderId, type AiProviderId } from '@shared/contracts/ai';

import { detectProvider } from './detect';

export const AI_SHARED_API_KEY_ENV = 'AI_SHARED_API_KEY';
export const AI_SHARED_PROVIDER_ENV = 'AI_SHARED_PROVIDER';
export const AI_SHARED_MODEL_ENV = 'AI_SHARED_MODEL';

export type AiEnv = Record<string, string | undefined>;
let env: AiEnv = {};

/** Entrypoints hand over their env once at boot; this feature never reads `process.env`. */
export function configureAiEnv(next: AiEnv): void {
  env = next;
}

export const aiEnv = (): AiEnv => env;

export type SharedAiConfig = { provider: AiProviderId; apiKey: string };

/**
 * The installation's shared key and provider, or null when it is not (validly)
 * configured. The provider is explicit when AI_SHARED_PROVIDER is set, else
 * detected from the key. Nothing here reads the database.
 */
export function sharedAiConfig(): SharedAiConfig | null {
  const apiKey = aiEnv()[AI_SHARED_API_KEY_ENV]?.trim();
  if (!apiKey) return null;
  const explicit = aiEnv()[AI_SHARED_PROVIDER_ENV]?.trim();
  if (explicit) return isAiProviderId(explicit) ? { provider: explicit, apiKey } : null;
  const detected = detectProvider(apiKey);
  return detected ? { provider: detected, apiKey } : null;
}
