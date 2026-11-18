/**
 * POST /mcp — stateless Streamable HTTP. Own bearer check (OAuth access
 * tokens only), then a fresh McpServer + transport per request whose tools
 * execute by dispatching to the app in-process with the caller's bearer.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';

import { createApiClient } from '../core/client';
import type { OperationContract } from '@shared/operation-contract';
import { registerOperationTools } from './tools';

export interface McpConfig {
  contracts: readonly OperationContract[];
  /** In-process request dispatch (the app's own fetch). */
  dispatch: (req: Request) => Promise<Response>;
  /** `<issuer>/.well-known/oauth-protected-resource`, advertised on 401. */
  resourceMetadataUrl: string;
  /** Validate an Authorization header as an OAuth access token; null = reject. */
  authenticate: (authorization: string | undefined) => Promise<{ scope?: string } | null>;
  /** Local dev with auth off: no token required, full access. */
  authDisabled: () => boolean;
  serverInfo?: { name: string; version: string };
}

const unauthorized = (cfg: McpConfig) =>
  new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${cfg.resourceMetadataUrl}"`,
    },
  });

const methodNotAllowed = () =>
  new Response(JSON.stringify({ error: 'method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' },
  });

export function mcpRoutes(cfg: McpConfig): Hono {
  const app = new Hono();

  app.on(['GET', 'DELETE'], '/mcp', () => methodNotAllowed());

  app.post('/mcp', async (c) => {
    const authorization = c.req.header('Authorization');
    let canWrite = true;
    if (!cfg.authDisabled()) {
      const principal = await cfg.authenticate(authorization);
      if (!principal) return unauthorized(cfg);
      canWrite = principal.scope === undefined || principal.scope.split(' ').includes('write');
    }
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined;
    const client = createApiClient({
      baseUrl: new URL(c.req.url).origin,
      token: bearer,
      fetch: cfg.dispatch,
    });

    const server = new McpServer(cfg.serverInfo ?? { name: 'budget', version: '1.0.0' });
    registerOperationTools(server, cfg.contracts, (contract, input) => client.call(contract, input), { canWrite });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
