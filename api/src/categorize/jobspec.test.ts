/**
 * The cost/timeout contract must stay self-consistent: the per-call deadline
 * the AI layer derives from the token cap, the per-transaction call cap, the
 * chunk size and the activity deadline all describe the same worst case.
 */
import { describe, expect, test } from 'bun:test';

import { chatTimeoutMs } from '../ai';
import {
  CATEGORIZE_CHUNK_SIZE,
  CATEGORIZE_CHUNK_TIMEOUT_MS,
  CATEGORIZE_RUN_LIMIT,
  CLASSIFY_CALL_DEADLINE_MS,
  CLASSIFY_MAX_CALLS,
  CLASSIFY_MAX_TOKENS,
  CLASSIFY_MAX_TOKENS_PER_TRANSACTION,
  forceFromInput,
  IN_CHUNK_RATE_LIMIT_WAIT_MS,
} from './jobspec';

describe('categorize cost bounds', () => {
  test('the per-call deadline is exactly what the token cap derives', () => {
    expect(chatTimeoutMs(CLASSIFY_MAX_TOKENS)).toBe(CLASSIFY_CALL_DEADLINE_MS);
  });

  test('the activity deadline covers chunk size x calls x deadline + one 429 wait', () => {
    expect(CATEGORIZE_CHUNK_TIMEOUT_MS).toBe(
      CATEGORIZE_CHUNK_SIZE * CLASSIFY_MAX_CALLS * CLASSIFY_CALL_DEADLINE_MS + IN_CHUNK_RATE_LIMIT_WAIT_MS,
    );
    expect(CATEGORIZE_CHUNK_TIMEOUT_MS).toBeGreaterThan(CATEGORIZE_CHUNK_SIZE * CLASSIFY_MAX_CALLS * CLASSIFY_CALL_DEADLINE_MS);
  });

  test('the caps are small and ordered', () => {
    // Reasoning tokens count toward the output cap, so 1k is not enough.
    expect(CLASSIFY_MAX_TOKENS).toBe(4000);
    expect(CLASSIFY_MAX_TOKENS_PER_TRANSACTION).toBe(80_000);
    // Every call's full output cap fits in the per-transaction budget.
    expect(CLASSIFY_MAX_TOKENS_PER_TRANSACTION).toBeGreaterThanOrEqual(CLASSIFY_MAX_CALLS * CLASSIFY_MAX_TOKENS);
    expect(CLASSIFY_MAX_CALLS).toBe(6);
    expect(CATEGORIZE_RUN_LIMIT).toBe(100);
  });

  test('force comes only from an explicit true', () => {
    expect(forceFromInput({ force: true })).toBe(true);
    expect(forceFromInput({ force: 'true' })).toBe(false);
    expect(forceFromInput({})).toBe(false);
    expect(forceFromInput(null)).toBe(false);
    expect(forceFromInput('force')).toBe(false);
  });
});
