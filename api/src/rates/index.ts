/** Rates feature barrel: the router (mounted at /rates post-auth gate) and its operation catalog. */
import type { AnyOperation } from '../core/operation';

import rates, { operations as ratesOps } from './routes/rates';

export const operations: readonly AnyOperation[] = [...ratesOps];

export default rates;
