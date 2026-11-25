import type { AiProviderId } from '@shared/contracts/ai';

/**
 * Provider-neutral AI failure. Adapters translate HTTP statuses and broken
 * payloads into one taxonomy, so routes and the categorizer can decide between
 * "the user's key is bad" and "the provider is having a bad day" without
 * knowing which vendor answered.
 */
export type AiErrorKind =
  /**
   * The provider refused the key (401). OpenAI also documents 401 for a key
   * that lacks the endpoint's scope, so a restricted key lands here.
   */
  | 'auth'
  /** Rate limit / quota (429). `retryAfterMs` when the provider said. */
  | 'rate_limited'
  /**
   * The deadline passed or the caller aborted. The adapter does not decide
   * retry policy: a non-streaming generation may already have been billed, so
   * the categorizer chooses (and can avoid replaying a started generation).
   */
  | 'timeout'
  /** Network error, 408 or 5xx that is not a deadline: worth retrying later. */
  | 'transient'
  /** A 4xx that is not auth or rate limiting: the request itself is wrong. */
  | 'permanent'
  /** The provider answered something that is not the documented shape. */
  | 'bad_response';

export class AiProviderError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly provider: AiProviderId | null = null,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
