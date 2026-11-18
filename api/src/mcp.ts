/**
 * MCP stdio entrypoint: reads env, wires the contracts catalog into the mcp
 * feature. Tools execute through the HTTP API as the user who ran
 * `bun run cli login` (stored credentials); without credentials requests go
 * unauthenticated, which works against an auth-disabled dev server.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { contracts } from './catalog';
import { createApiClient } from './core/client';
import { getAccessToken, normalizeApiUrl, resolveConfigDir } from './cli/index';
import { registerOperationTools } from './mcp/index';

const apiUrl = normalizeApiUrl(process.env.BUDGET_API_URL || process.env.API_URL || 'http://localhost:3100');
const configDir = resolveConfigDir(process.env);

const server = new McpServer({ name: 'budget', version: '1.0.0' });
registerOperationTools(server, contracts, async (contract, input) =>
  // Token resolved per call so a long-lived session picks up refreshes.
  createApiClient({ baseUrl: apiUrl, token: await getAccessToken({ apiUrl, configDir }) }).call(contract, input),
);

await server.connect(new StdioServerTransport());
console.error(`budget MCP server running on stdio (api: ${apiUrl})`);
