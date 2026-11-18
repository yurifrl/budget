/**
 * Temporal workflow bundle entry. Imports nothing but @temporalio/workflow:
 * the workflow sandbox cannot load hono, pg or feature barrels.
 */
import { proxyActivities } from '@temporalio/workflow';

export interface HelloActivities {
  greet(name: string): Promise<string>;
}

const { greet } = proxyActivities<HelloActivities>({ startToCloseTimeout: '10 seconds' });

export async function helloWorkflow(name: string): Promise<string> {
  return greet(name);
}
