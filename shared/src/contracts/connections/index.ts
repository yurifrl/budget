/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as connectionsContracts from './connections';

export { connectionsSummary, connectionsSyncStatus, connectionsTransactions } from './connections';

export const contracts = collectContracts(
  connectionsContracts,
);
