/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as grantsContracts from './grants';

export * from './grants';
export const contracts = collectContracts(grantsContracts);
