/**
 * One provider call at a time per AI key, in this process.
 *
 * A run walks its chunks sequentially, and chunks on the `-ai` queue run one at
 * a time per worker (worker.ts sets maxConcurrentActivityTaskExecutions: 1),
 * but two worker pods (or a second budget of the same owner in one pod) can
 * still share one key. Serializing the model calls per owner keeps a shared or
 * personal key under its provider's concurrent-request limit by default: a
 * second caller waits instead of firing a parallel request. The lock is
 * in-process only; across pods the provider's 429 is what bounds concurrency,
 * and ./chunk.ts retries the one transaction after the provider's delay.
 */
const tails = new Map<string, Promise<void>>();

/** Run `body` after every previously queued body for `key` has settled. */
export async function withKeyLock<T>(key: string, body: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  await previous;
  try {
    return await body();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
