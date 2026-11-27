/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as decisionsContracts from './decisions';
import * as queueContracts from './queue';
import * as runContracts from './run';
import * as settingsContracts from './settings';
import * as transfersContracts from './transfers';

export * from './decisions';
export * from './outputs';
export * from './queue';
export * from './run';
export * from './settings';
export * from './transfers';

export const contracts = collectContracts(decisionsContracts, queueContracts, runContracts, settingsContracts, transfersContracts);
