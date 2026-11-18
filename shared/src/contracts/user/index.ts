/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as meContracts from './me';

export * from './me';
export const contracts = collectContracts(meContracts);
