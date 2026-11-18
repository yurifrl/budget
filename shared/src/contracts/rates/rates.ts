import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';

export const ratesUsdBrl = defineOperation({
  name: 'rates_usd_brl',
  description:
    'Indicative USD to BRL exchange rate (BRL per 1 USD, e.g. 5.32), cached up to 6 hours from public sources. Returns rate, source name, stale (true when served from cache after the sources failed) and fetched_at.',
  input: z.object({}),
  output: z.object({
    /** BRL per 1 USD (a ratio, not money). */
    rate: z.number(),
    source: z.string(),
    /** True when served from cache after every source failed. */
    stale: z.boolean(),
    fetched_at: z.string(),
  }),
  method: 'GET',
  path: '/rates/usd-brl',
  kind: 'read',
  expose: EXPOSE_ALL,
});
