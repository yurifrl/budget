/**
 * MCP feature: authenticated /mcp endpoint with tools generated from the
 * operation catalog. Mount BEFORE the auth gate — it does its own bearer check.
 */
export { mcpRoutes as createMcpRouter, type McpConfig } from './router';
export { registerOperationTools, mcpOperations, type CallOperation, type RegisterOptions } from './tools';
