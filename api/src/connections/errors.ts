/**
 * Provider-neutral failure taxonomy for bank aggregators. Adapters translate
 * their vendor errors into `AggregatorError`; the sync job maps `kind` onto
 * Temporal retry behaviour and `connections.status` — the core never inspects
 * vendor status codes.
 *
 *  - auth           credentials/consent no longer valid → not retryable, status 'unauthorized'
 *  - rate_limited   provider asked us to slow down → retry after `retryAfterMs`
 *  - quota_exhausted the provider's monthly quota is spent → stale, not broken
 *  - transient      5xx / timeouts / network → retry with backoff
 *  - permanent      anything else that will not heal by retrying (bad config, 404, 4xx)
 */
export type AggregatorErrorKind = 'auth' | 'rate_limited' | 'quota_exhausted' | 'transient' | 'permanent';

export class AggregatorError extends Error {
  constructor(
    public readonly kind: AggregatorErrorKind,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AggregatorError';
  }
}

/** User-safe text per failure kind. Never carries provider/driver detail. */
export const USER_MESSAGES = {
  auth: 'Reconnect your bank',
  quota_exhausted: 'Bank limits reached — data resumes next month',
  rate_limited: 'The bank is limiting requests right now. We will try again shortly.',
  transient: "Couldn't reach the bank. We will try again later.",
  permanent: "Couldn't sync with the bank. Try again later.",
} as const satisfies Record<AggregatorErrorKind, string>;

/**
 * `status_message` of a 'paused' connection, by the key set it was created
 * with. A provider item cannot move between key sets, so a paused shared-key
 * connection is replaced (connected again with own keys), not converted.
 */
export const PAUSE_MESSAGES = {
  shared:
    "Paused: this bank was connected with the app's shared Pluggy keys, which are not available for your account. Add your own Pluggy keys and connect the bank again.",
  own: 'Paused: the Pluggy keys this bank was connected with are no longer saved. Save that key set again to resume.',
} as const;

/** Run notice when a sync found its connection paused (nothing was pulled). */
export const PAUSED_RUN_MESSAGE = 'Nothing synced: this bank is paused until its Pluggy keys can be used again.';
