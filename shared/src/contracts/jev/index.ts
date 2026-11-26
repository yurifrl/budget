/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as keyContracts from './key';

export * from './key';
export * from './outputs';

export const contracts = collectContracts(keyContracts);
