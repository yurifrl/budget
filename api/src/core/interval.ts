/**
 * Shared helpers for unattended background ticks (cross-cutting, feature-free).
 *
 * - parseIntEnv: a safe integer from a raw env string. Blank / NaN / below the
 *   floor must never reach setInterval (0 or NaN fires continuously).
 * - createSingleFlight: a tick that is skipped (logged once per
 *   overlap) while the previous run is still in flight, and never lets a
 *   rejection escape.
 */

/**
 * Parse `raw` as an integer >= `min` (default 1). Anything else — undefined,
 * blank, non-numeric, non-integer, below the floor — yields `fallback`.
 */
export function parseIntEnv(raw: string | undefined, fallback: number, min = 1): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return fallback;
  return n;
}

/**
 * Wrap `fn` so concurrent invocations are skipped while one is in flight.
 * Errors (sync or async) are logged, never rethrown. A skip is logged once per
 * overlap episode, not on every skipped tick.
 */
export function createSingleFlight<A extends unknown[]>(
  name: string,
  fn: (...args: A) => unknown,
  log: Pick<Console, 'warn' | 'error'> = console,
): (...args: A) => Promise<void> {
  let running = false;
  let warned = false;
  return async (...args: A) => {
    if (running) {
      if (!warned) {
        warned = true;
        log.warn(`${name}: previous run still in flight, skipping overlapping tick`);
      }
      return;
    }
    running = true;
    try {
      await fn(...args);
    } catch (error) {
      log.error(`${name} failed:`, error);
    } finally {
      running = false;
      warned = false;
    }
  };
}

/**
 * setInterval for a (single-flight) tick; refuses an interval that would spin.
 * Returns a stop function.
 */
export function startInterval(tick: () => unknown, ms: number): () => void {
  if (!Number.isFinite(ms) || ms < 1) {
    throw new Error(`invalid interval ${ms}ms`);
  }
  const timer = setInterval(() => void tick(), ms);
  return () => clearInterval(timer);
}
