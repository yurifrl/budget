/**
 * Generate MCP tools from operation contracts. Execution goes through the
 * injected `call` (an API client bound to the caller's bearer), never the DB,
 * so auth, ownership and validation run exactly as for any API request.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ApiError } from '../core/client';
import type { OperationContract } from '@shared/operation-contract';

/** Run a contract with validated input; resolves to the API's JSON, rejects with ApiError. */
export type CallOperation = (contract: OperationContract, input: Record<string, unknown>) => Promise<unknown>;

export interface RegisterOptions {
  /** false = read-only grant: only `read` tools are registered. Default true. */
  canWrite?: boolean;
}

/** Contracts that become tools for this caller. */
export function mcpOperations(contracts: readonly OperationContract[], canWrite = true): OperationContract[] {
  return contracts.filter((contract) => contract.expose.mcp && (canWrite || contract.kind === 'read'));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Register one tool per MCP-exposed operation on `server`; returns the tool names. */
export function registerOperationTools(
  server: McpServer,
  contracts: readonly OperationContract[],
  call: CallOperation,
  options: RegisterOptions = {},
): string[] {
  const names: string[] = [];
  for (const contract of mcpOperations(contracts, options.canWrite ?? true)) {
    server.registerTool(
      contract.name,
      {
        description: contract.description,
        inputSchema: contract.input.shape,
        annotations: {
          readOnlyHint: contract.kind === 'read',
          destructiveHint: contract.kind === 'destructive',
        },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const data = await call(contract, args);
          const text = data === null || data === undefined ? 'ok' : JSON.stringify(data);
          return isPlainObject(data)
            ? { content: [{ type: 'text', text }], structuredContent: data }
            : { content: [{ type: 'text', text }] };
        } catch (err) {
          const message =
            err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : err instanceof Error ? err.message : String(err);
          return { isError: true, content: [{ type: 'text', text: message }] };
        }
      },
    );
    names.push(contract.name);
  }
  return names;
}
