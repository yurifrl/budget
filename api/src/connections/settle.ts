/**
 * The connect widget reports success the moment the provider accepts the
 * credentials, but the freshly created upstream item's accounts often take a
 * moment to appear — an immediate listing can legitimately return none and
 * strand the caller on an empty account chooser. Retry the first listing with
 * a short settle window; later listing calls (sync, re-auth) run after the
 * item has existed for a while and use the aggregator directly.
 */

const SETTLE_MS = 5_000;
const SETTLE_ATTEMPTS = 12;

/** Retry an upstream account listing that may race the item's creation. */
export async function withPostConnectSettle<T>(list: () => Promise<T[]>): Promise<T[]> {
  let last: T[] = [];
  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
    last = await list();
    if (last.length > 0) return last;
    if (attempt < SETTLE_ATTEMPTS) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, SETTLE_MS);
      await promise;
    }
  }
  return last;
}
