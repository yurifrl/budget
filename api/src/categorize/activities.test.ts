/**
 * The activity boundary: failure translation into the Temporal retry policy,
 * the heartbeat payload as resume state, and the ledger fields a failure may
 * carry (kind + Postgres code, never a message or provider text).
 */
import { describe, expect, test } from 'bun:test';
import { ApplicationFailure } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';

import { CategorizeError, failureForProviderError } from './errors';
import { failureLogFields, readProgress, toActivityFailure } from './activities';
import { MAX_RATE_LIMIT_DELAY_MS } from './jobspec';
import { CATEGORIZE_FAILURE_MESSAGES } from './messages';
import { AiProviderError } from '../ai';

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

  test('systematic request failures stop the run with a user-safe sentence', () => {
    const failure = toActivityFailure(new CategorizeError('systematic', none)) as ApplicationFailure;
    expect(failure.type).toBe('AiSystematic');
    expect(failure.nonRetryable).toBe(true);
    expect(failure.message).toBe('the AI provider refused the request repeatedly');
    expect(CATEGORIZE_FAILURE_MESSAGES.AiSystematic).toContain('run stopped');
    expect(failure.message).not.toContain('upstream');
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

describe('per-transaction vs account-level provider errors', () => {
  test('400/413/422 are request-scoped; other 4xx stay permanent', () => {
    for (const status of [400, 413, 422]) {
      expect(failureForProviderError(new AiProviderError('permanent', 'x', status), none).kind).toBe('request');
    }
    for (const status of [402, 403, 404, 409]) {
      expect(failureForProviderError(new AiProviderError('permanent', 'x', status), none).kind).toBe('permanent');
    }
    expect(failureForProviderError(new AiProviderError('permanent', 'x'), none).kind).toBe('permanent');
    expect(failureForProviderError(new AiProviderError('auth', 'x', 401), none).kind).toBe('auth');
    expect(failureForProviderError(new AiProviderError('rate_limited', 'x', 429), none).kind).toBe('rate_limited');
  });
});

describe('ledger fields for a failure', () => {
  test('a categorize failure logs its kind only', () => {
    expect(failureLogFields(new CategorizeError('auth', none))).toEqual({ kind: 'auth' });
  });

  test('an unexpected driver error logs its code, never its message', () => {
    const pgError = Object.assign(new Error('invalid input syntax for type uuid: "txn_1"'), { code: '22P02' });
    expect(failureLogFields(pgError)).toEqual({ kind: 'internal', pg_code: '22P02' });
    expect(JSON.stringify(failureLogFields(pgError))).not.toContain('txn_1');
  });

  test('an unknown error without a code logs only internal', () => {
    expect(failureLogFields(new Error('sk-secret 123'))).toEqual({ kind: 'internal' });
  });
});

describe('heartbeat details as resume state', () => {
  const progress = {
    examined: 2,
    total: 10,
    cursor: { date: '2026-11-02', id: '5f0f0a6e-1f5b-4a63-9a63-8c1f6f2d4a01' },
    suggested: 1,
    rule: 1,
    empty: 0,
    skipped: 0,
    failed: 0,
    failedIds: [],
    inputTokens: 30,
    outputTokens: 12,
  };

  test('a complete payload is accepted unchanged', () => {
    expect(readProgress(progress)).toEqual(progress);
    expect(readProgress(null)).toBeNull();
  });

  test('a malformed payload is ignored (fresh start), not trusted', () => {
    expect(readProgress({ examined: '2' })).toBeNull();
    expect(readProgress({ ...progress, failedIds: [1] })).toBeNull();
    expect(readProgress({ ...progress, cursor: { date: 1, id: 2 } })).toBeNull();
  });
});
