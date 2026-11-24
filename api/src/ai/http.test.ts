/**
 * The shared HTTP path: a chat deadline must fit its token cap, and a timed-out
 * chat must never look retryable (the aborted generation may already be billed).
 */
import { describe, expect, test } from 'bun:test';

import { AiProviderError } from './errors';
import { chatTimeoutMs, DEFAULT_CHAT_TIMEOUT_MS, requestJson, type FetchLike } from './http';

describe('chat deadline', () => {
  test('never below the 60 s floor, longer for a large output cap', () => {
    expect(chatTimeoutMs(undefined)).toBe(DEFAULT_CHAT_TIMEOUT_MS);
    expect(chatTimeoutMs(512)).toBe(DEFAULT_CHAT_TIMEOUT_MS);
    // Anthropic's 16k default must get room for long thinking turns.
    expect(chatTimeoutMs(16_000)).toBeGreaterThanOrEqual(600_000);
    expect(chatTimeoutMs(16_000)).toBeGreaterThan(chatTimeoutMs(4_000));
  });
});

describe('timed-out request', () => {
  test('is permanent, not transient, so a retry cannot pay for the same generation twice', async () => {
    const hangingFetch: FetchLike = (_input, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
      return promise;
    };

    const failure = await requestJson({ provider: 'openai', url: 'https://stub.test/chat', timeoutMs: 10, fetch: hangingFetch }).catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(AiProviderError);
    expect(failure).toMatchObject({ kind: 'permanent', status: null });
    expect((failure as AiProviderError).message).toContain('timed out after 10 ms');
    expect((failure as AiProviderError).message).toContain('openai');
  });
});
