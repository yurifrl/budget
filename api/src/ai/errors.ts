/**
 * Provider-neutral AI failure. Adapters translate HTTP statuses and broken
 * payloads into one taxonomy, so routes (and later the categorizer) can decide
 * between "the user's key is bad" and "the provider is having a bad day"
 * without knowing which vendor answered.
 */
export type AiErrorKind =
  /** The provider refused the key (401/403, or its own auth error). */
  | 'auth'
  /** Rate limit / quota (429). `retryAfterMs` when the provider said. */
  | 'rate_limited'
  /** Network error, timeout, 408 or 5xx: worth retrying later. */
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
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
