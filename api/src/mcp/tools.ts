/**
 * Register MCP tools from operation contracts, the way syscd-app
 * server/mcp/tools.ts does: `inputSchema: contract.input.shape`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { OperationContract } from '@shared/operation-contract';

export type CallOperation = (contract: OperationContract, input: Record<string, unknown>) => Promise<unknown>;

export function registerOperationTools(
  server: McpServer,
  contracts: readonly OperationContract[],
  call: CallOperation,
): string[] {
  const names: string[] = [];
  for (const contract of contracts.filter((c) => c.expose.mcp)) {
    server.registerTool(
      contract.name,
      {
        description: contract.description,
        inputSchema: contract.input.shape,
        annotations: { readOnlyHint: contract.kind === 'read', destructiveHint: contract.kind === 'destructive' },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const data = await call(contract, args);
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      },
    );
    names.push(contract.name);
  }
  return names;
}
