/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as meContracts from './me';
import * as providerContracts from './providers';

export * from './me';
export * from './providers';
export const contracts = collectContracts(meContracts, providerContracts);
