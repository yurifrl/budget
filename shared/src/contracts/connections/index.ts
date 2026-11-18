/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as connectionsContracts from './connections';

export * from './connections';
export * from './outputs';

export const contracts = collectContracts(
  connectionsContracts,
);
