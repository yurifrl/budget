/**
 * Generate MCP tools from operation contracts. Execution goes through the
 * injected `call` (an API client bound to the caller's bearer), never the DB,
 * so auth, ownership and validation run exactly as for any API request.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { z } from '@shared/zod';
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

/**
 * Rebuild a schema with every object loose (extra keys allowed). Output
 * schemas are non-strict on purpose (rows carry more columns than declared),
 * but a zod object exports `additionalProperties: false` as JSON Schema, and
 * MCP clients validate `structuredContent` against the advertised schema.
 */
function loosen(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, loosen(v as z.ZodType)]));
    return z.looseObject(shape);
  }
  if (schema instanceof z.ZodArray) return z.array(loosen(schema.element as z.ZodType));
  if (schema instanceof z.ZodNullable) return loosen(schema.unwrap() as z.ZodType).nullable();
  if (schema instanceof z.ZodOptional) return loosen(schema.unwrap() as z.ZodType).optional();
  return schema;
}

/**
 * The tool's outputSchema: MCP requires an object schema, so only contracts
 * whose `output` is a zod object get one (lists and 204s do not). The SDK
 * advertises it in tools/list and checks `structuredContent` against it; it
 * is the contract's output with every object loosened (see `loosen`).
 */
export function mcpOutputSchema(contract: OperationContract): z.ZodObject<z.ZodRawShape> | undefined {
  return contract.output instanceof z.ZodObject ? (loosen(contract.output) as z.ZodObject<z.ZodRawShape>) : undefined;
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
    const outputSchema = mcpOutputSchema(contract);
    server.registerTool(
      contract.name,
      {
        description: contract.description,
        inputSchema: contract.input.shape,
        ...(outputSchema ? { outputSchema } : {}),
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
