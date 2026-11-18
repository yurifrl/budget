/**
 * rates — indicative USD→BRL exchange rate for scheduled-row currency
 * conversion. The ledger stays in BRL; when a scheduled amount is typed in
 * USD ($), the client needs an indicative BRL value to prefill the editable
 * conversion. Fetched from a public API, cached in-memory with a TTL so the
 * upstream is hit at most once per TTL even across many rows/budgets.
 *
 * Stale-while-error: if the upstream fetch fails, the last successful rate
 * is served (marked stale) rather than failing the row editor.
 */

import { Hono } from 'hono';
import { z } from '@shared/zod';

import { implement, mountOperations } from '../../core/operation';
import { ratesUsdBrl } from '@shared/contracts/rates/rates';

const rateSchema = z.object({ rates: z.object({ BRL: z.number().positive() }) }).passthrough();
const awesomeSchema = z.object({ USDBRL: z.object({ bid: z.string() }) }).passthrough();

/** Public no-key APIs, tried in order. Each returns BRL per 1 USD. */
const SOURCES: { name: string; url: string; parse: (json: unknown) => number }[] = [
  {
    name: 'frankfurter',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL',
    parse: (json) => rateSchema.safeParse(json).data?.rates.BRL ?? NaN,
  },
  {
    name: 'open-er-api',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: (json) => rateSchema.safeParse(json).data?.rates.BRL ?? NaN,
  },
  {
    name: 'awesomeapi',
    url: 'https://economia.awesomeapi.com.br/json/last/USD-BRL',
    parse: (json) => {
      const rate = Number(awesomeSchema.safeParse(json).data?.USDBRL.bid);
      return rate > 0 ? rate : NaN;
    },
  },
];

/** Cache TTL: 6 hours — indicative rate, not a trading feed. */
const TTL_MS = 6 * 60 * 60 * 1000;

let cache: { rate: number; source: string; fetchedAt: number } | null = null;

async function fetchRate(): Promise<{ rate: number; source: string; stale: boolean }> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) {
    return { rate: cache.rate, source: cache.source, stale: false };
  }
  for (const source of SOURCES) {
    try {
      const res = await fetch(source.url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const rate = source.parse(await res.json());
      if (!Number.isFinite(rate) || rate <= 0) continue;
      cache = { rate, source: source.name, fetchedAt: Date.now() };
      return { rate, source: source.name, stale: false };
    } catch {
      // try the next source
    }
  }
  if (cache) return { rate: cache.rate, source: cache.source, stale: true };
  throw new Error('no exchange-rate source available');
}

export const operations = [
  implement(ratesUsdBrl, async () => {
    const { rate, source, stale } = await fetchRate();
    return {
      // BRL per 1 USD (e.g. 5.32). USD cents * rate = BRL cents.
      rate,
      source,
      stale,
      fetched_at: new Date().toISOString(),
    };
  }),
];

/** Relative to its mount point: server/app.ts mounts this at `/rates`. */
export default mountOperations(new Hono(), operations, { basePath: '/rates' });
