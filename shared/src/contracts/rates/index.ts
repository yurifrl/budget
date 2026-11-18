/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as ratesContracts from './rates';

export const contracts = collectContracts(
  ratesContracts,
);
