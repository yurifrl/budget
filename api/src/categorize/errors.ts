/**
 * Categorizer failures. `kind` is the provider-neutral taxonomy the activity's
 * retry policy keys on; `usage` carries the tokens spent before the failure so
 * the run's ledger totals do not undercount billed calls.
 *
 * Messages are fixed, user-safe text with NO provider text in them: an error
 * thrown here reaches jobs.job_attempts/job_logs through the jobs ledger, and
 * this feature keeps no raw provider error anywhere (see the no-key-in-logs
 * rule in tools/activities). The original AiProviderError is deliberately not
 * carried: its message may contain upstream response text.
 */
import type { AiProviderError } from '../ai';
import type { AiTokenUsage } from '../ai';

export type CategorizeFailureKind =
  /** The key is refused: stop the run. */
  | 'auth'
  /** Account/key-level 4xx (billing, scopes, model not found): stop the run. */
  | 'permanent'
  /** 429: wait and retry the one transaction, or let the activity retry. */
  | 'rate_limited'
  /** Network/5xx/deadline of the transport: the activity retries. */
  | 'transient'
  /** One call missed its deadline; retried once for that transaction. */
  | 'timeout'
  /** The answer is not the schema (or names no known category): that transaction fails. */
  | 'bad_response'
  /**
   * A 4xx about the request itself (400/413/422: context length, request size,
   * content filter). Scoped to this transaction, so the run continues.
   */
  | 'request'
  /** The transaction spent CLASSIFY_MAX_TOKENS_PER_TRANSACTION: it fails, the run continues. */
  | 'budget';

const SAFE_MESSAGES: Record<CategorizeFailureKind, string> = {
  auth: 'the AI provider refused the key',
  permanent: 'the AI provider refused the request',
  rate_limited: 'the AI provider is rate limiting requests',
  transient: 'the AI provider is unavailable',
  timeout: 'the AI provider did not answer in time',
  bad_response: 'the AI provider answered something that is not a category suggestion',
  request: 'the AI provider refused that transaction',
  budget: 'that transaction exceeded its token budget',
};

/**
 * HTTP statuses that are about THIS request's shape or size, per the provider
 * error docs: Anthropic 400 `invalid_request_error` ("issue with the format or
 * content of your request") and 413 `request_too_large`; OpenAI 400
 * `invalid_request_error`. 422 is included for OpenAI-compatible providers
 * that use it for an unprocessable body. Every other non-401/non-429 4xx
 * (402 billing, 403 scope, 404 model) is account/key-level and stops the run.
 */
const REQUEST_SCOPED_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

export class CategorizeError extends Error {
  constructor(
    readonly kind: CategorizeFailureKind,
    readonly usage: AiTokenUsage,
    /** Provider-requested wait for kind 'rate_limited', dry. */
    readonly retryAfterMs: number | null = null,
    /** HTTP status when a provider error produced this one (never returned to a user). */
    readonly status: number | null = null,
  ) {
    super(SAFE_MESSAGES[kind]);
    this.name = 'CategorizeError';
  }
}

/** Map a provider failure onto the categorizer's per-transaction/run-level split. */
export function failureForProviderError(error: AiProviderError, usage: AiTokenUsage): CategorizeError {
  if (error.kind === 'permanent' && error.status !== null && REQUEST_SCOPED_STATUSES.has(error.status)) {
    return new CategorizeError('request', usage, error.retryAfterMs, error.status);
  }
  return new CategorizeError(error.kind, usage, error.retryAfterMs, error.status);
}
