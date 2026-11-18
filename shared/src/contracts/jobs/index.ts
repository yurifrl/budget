/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as jobsContracts from './jobs';

export const contracts = collectContracts(
  jobsContracts,
);
