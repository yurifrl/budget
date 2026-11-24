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
import type { AiTokenUsage } from '../ai';

export type CategorizeFailureKind = 'auth' | 'permanent' | 'rate_limited' | 'transient' | 'timeout' | 'bad_response';

const SAFE_MESSAGES: Record<CategorizeFailureKind, string> = {
  auth: 'the AI provider refused the key',
  permanent: 'the AI provider refused the request',
  rate_limited: 'the AI provider is rate limiting requests',
  transient: 'the AI provider is unavailable',
  timeout: 'the AI provider did not answer in time',
  bad_response: 'the AI provider answered something that is not a category suggestion',
};

export class CategorizeError extends Error {
  constructor(
    readonly kind: CategorizeFailureKind,
    readonly usage: AiTokenUsage,
    /** Provider-requested wait for kind 'rate_limited', dry. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(SAFE_MESSAGES[kind]);
    this.name = 'CategorizeError';
  }
}
