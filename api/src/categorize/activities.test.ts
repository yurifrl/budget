/**
 * The activity failure translation: each AiProviderError kind maps onto the
 * Temporal retry policy the workflow relies on (auth/permanent non-retryable,
 * rate limits with the provider's own delay, everything else retryable), and
 * no provider text or key reaches the ledger.
 */
import { describe, expect, test } from 'bun:test';
import { ApplicationFailure } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';

import { CategorizeError } from './errors';
import { toActivityFailure } from './activities';
import { MAX_RATE_LIMIT_DELAY_MS } from './jobspec';

const none = { input: 0, output: 0 };

describe('activity failure translation', () => {
  test('auth and permanent are non-retryable', () => {
    const auth = toActivityFailure(new CategorizeError('auth', none)) as ApplicationFailure;
    expect(auth.type).toBe('AiAuth');
    expect(auth.nonRetryable).toBe(true);

    const permanent = toActivityFailure(new CategorizeError('permanent', none)) as ApplicationFailure;
    expect(permanent.type).toBe('AiPermanent');
    expect(permanent.nonRetryable).toBe(true);
  });

  test('rate_limited waits the provider retry-after, capped', () => {
    const quick = toActivityFailure(new CategorizeError('rate_limited', none, 12_000)) as ApplicationFailure;
    expect(quick.type).toBe('AiRateLimited');
    expect(quick.nonRetryable).not.toBe(true);
    expect(quick.nextRetryDelay).toBe(12_000);

    const noHeader = toActivityFailure(new CategorizeError('rate_limited', none)) as ApplicationFailure;
    expect(noHeader.nextRetryDelay).toBe(60_000);

    const absurd = toActivityFailure(new CategorizeError('rate_limited', none, 10 * 60 * 60_000)) as ApplicationFailure;
    expect(absurd.nextRetryDelay).toBe(MAX_RATE_LIMIT_DELAY_MS);
  });

  test('transient, timeout and bad_response are retryable transients', () => {
    for (const kind of ['transient', 'timeout', 'bad_response'] as const) {
      const failure = toActivityFailure(new CategorizeError(kind, none)) as ApplicationFailure;
      expect(failure.type).toBe('AiTransient');
      expect(failure.nonRetryable).not.toBe(true);
    }
  });

  test('an unknown failure becomes a transient with no original text', () => {
    const failure = toActivityFailure(new Error('sk-leaky-key-0123456789 upstream detail')) as ApplicationFailure;
    expect(failure.type).toBe('AiTransient');
    expect(failure.message).toBe('categorize activity failed');
    expect(failure.message).not.toContain('sk-leaky-key');
  });

  test('cancellation passes through untouched', () => {
    const cancelled = new CancelledFailure('cancelled');
    expect(toActivityFailure(cancelled)).toBe(cancelled);
  });
});
