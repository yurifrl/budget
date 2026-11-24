/**
 * The shared HTTP path: a chat deadline must fit its token cap, a timed-out
 * chat must not choose retry policy for the caller, non-chat deadlines stay
 * retryable, and a caller abort must reach the socket promptly.
 */
import { describe, expect, test } from 'bun:test';

import { AiProviderError } from './errors';
import { chatTimeoutMs, DEFAULT_CHAT_TIMEOUT_MS, requestJson, type FetchInit, type FetchLike } from './http';

const hangingFetch: FetchLike = (_input, init) => {
  const { promise, reject } = Promise.withResolvers<Response>();
  init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
  return promise;
};

describe('chat deadline', () => {
  test('never below the 60 s floor, 640 s for 16k, and 640 s when the cap is unset', () => {
    expect(chatTimeoutMs(512)).toBe(DEFAULT_CHAT_TIMEOUT_MS);
    expect(chatTimeoutMs(16_000)).toBe(640_000);
    expect(chatTimeoutMs(undefined)).toBe(640_000);
    expect(chatTimeoutMs(16_000)).toBeGreaterThan(chatTimeoutMs(4_000));
  });
});

describe('deadline kind', () => {
  test('a non-chat timeout stays transient (nothing was generated)', async () => {
    const failure = await requestJson({ provider: 'openai', url: 'https://stub.test/models', timeoutMs: 10, fetch: hangingFetch }).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(AiProviderError);
    expect(failure).toMatchObject({ kind: 'transient', status: null, provider: 'openai' });
  });

  test('a chat timeout is kind timeout and leaves retry policy to the caller', async () => {
    const failure = await requestJson({
      provider: 'anthropic',
      url: 'https://stub.test/messages',
      timeoutMs: 10,
      timeoutKind: 'timeout',
      fetch: hangingFetch,
    }).catch((err: unknown) => err);
    expect(failure).toMatchObject({ kind: 'timeout', status: null, provider: 'anthropic' });
    expect((failure as AiProviderError).message).toContain('timed out after 10 ms');
  });
});

describe('caller cancellation', () => {
  test('an aborted request rejects promptly as timeout', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
        queueMicrotask(() => controller.abort());
      });
    const failure = await requestJson({
      provider: 'openai',
      url: 'https://stub.test/chat',
      timeoutMs: 60_000,
      timeoutKind: 'timeout',
      signal: controller.signal,
      fetch: fetchImpl,
    }).catch((err: unknown) => err);
    expect(failure).toMatchObject({ kind: 'timeout', status: null, provider: 'openai' });
    expect((failure as AiProviderError).message).toContain('cancelled');
  });
});

describe('Bun socket idle timer', () => {
  test('chat requests disable it so the AbortSignal deadline is the only timer', async () => {
    let init: FetchInit | undefined;
    const fetchImpl: FetchLike = async (_input, requestInit) => {
      init = requestInit;
      return Response.json({});
    };
    await requestJson({
      provider: 'openai',
      url: 'https://stub.test/chat',
      timeoutMs: 640_000,
      timeoutKind: 'timeout',
      disableSocketIdleTimeout: true,
      fetch: fetchImpl,
    });
    expect(init?.timeout).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
