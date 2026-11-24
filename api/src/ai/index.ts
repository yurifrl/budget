/**
 * AI feature barrel: key routes (post-gate), env configuration for the
 * entrypoints, and the key/provider surface the categorizer will consume.
 */
export { default, default as routes, operations } from './routes';
export { configureAiEnv, AI_SHARED_API_KEY_ENV, AI_SHARED_MODEL_ENV, AI_SHARED_PROVIDER_ENV, sharedAiConfig } from './env';
export { aiKeyHttpError, resolveAiKey, sharedAiAllowed, sharedAiStatus, storeOwnKey, type AiKeyProblem } from './keys';
export { detectProvider } from './detect';
export { providerFor, providerBaseUrl, type ResolvedAiKey } from './providers';
export { redactSecrets } from './redact';
export { AiProviderError, type AiErrorKind } from './errors';
export type { AiChatRequest, AiChatResult, AiJsonSchema, AiMessage, AiModel, AiProvider, AiTokenUsage, AiTool, AiToolCall } from './types';
