/**
 * Zod identity proof: the MCP SDK accepts a schema built with shared/'s zod
 * instance, and api/ has no zod of its own.
 */
import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { helloGet } from '@shared/contracts/hello';
import { z as sharedZ } from '@shared/zod';

import apiPkg from '../../package.json';
import { registerOperationTools } from './tools';

const apiDir = path.resolve(import.meta.dir, '../..');
const sharedZodDir = realpathSync(path.resolve(apiDir, '../shared/node_modules/zod'));

describe('MCP SDK + shared zod', () => {
  test('registers, lists and calls a tool whose schema came from shared/', async () => {
    const server = new McpServer({ name: 'budget-test', version: '0.0.0' });
    const names = registerOperationTools(server, [helloGet], async (_c, input) => ({
      message: `Hello, ${(input.name as string | undefined) ?? 'world'}!`,
    }));
    expect(names).toEqual(['hello_get']);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: 'budget-test-client', version: '0.0.0' });
    await client.connect(clientT);

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'hello_get');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
    });

    const ok = await client.callTool({ name: 'hello_get', arguments: { name: 'Ada' } });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toEqual([{ type: 'text', text: '{"message":"Hello, Ada!"}' }]);

    // Validation runs through the shared schema (min(1)) inside the SDK.
    const bad = await client.callTool({ name: 'hello_get', arguments: { name: '' } });
    expect(bad.isError).toBe(true);

    await client.close();
    await server.close();
  });

  test('the contract schema is an instance of shared/ zod', () => {
    expect(helloGet.input).toBeInstanceOf(sharedZ.ZodObject);
  });

  test('api/package.json does not depend on zod', () => {
    const pkg = apiPkg as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.dependencies?.zod).toBeUndefined();
    expect(pkg.devDependencies?.zod).toBeUndefined();
  });

  test("resolving 'zod' from api/ (and from the MCP SDK) lands on shared/'s copy", () => {
    const fromApi = createRequire(path.join(apiDir, 'src/index.ts')).resolve('zod/package.json');
    expect(realpathSync(path.dirname(fromApi))).toBe(sharedZodDir);

    const sdkEntry = Bun.resolveSync('@modelcontextprotocol/sdk/server/mcp.js', apiDir);
    const fromSdk = createRequire(sdkEntry).resolve('zod/package.json');
    expect(realpathSync(path.dirname(fromSdk))).toBe(sharedZodDir);
  });
});
