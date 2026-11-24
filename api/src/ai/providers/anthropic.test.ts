/**
 * Anthropic adapter against a local stub HTTP server: Messages API mapping
 * (system, tool_use/tool_result blocks, structured output), model pagination
 * and error mapping. No real provider is called.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';

import { createProvider } from './index';

type Captured = { method: string; path: string; headers: Record<string, string>; body: unknown };
let server: Server<undefined> | null = null;
let captured: Captured[] = [];

function stub(respond: (req: Request, body: unknown) => Response | Promise<Response>): string {
  captured = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      const body = text ? (JSON.parse(text) as unknown) : null;
      const url = new URL(req.url);
      captured.push({ method: req.method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(req.headers.entries()), body });
      return respond(req, body);
    },
  });
  return `http://localhost:${server.port}`;
}

afterEach(async () => {
  await server?.stop(true);
  server = null;
});

describe('Anthropic chat request', () => {
  test('system, tool blocks, structured output and headers map to the Messages API', async () => {
    const baseUrl = stub(() =>
      Response.json({
        model: 'claude-test',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'list_categories', input: { budget_id: 'b1' } },
        ],
      }),
    );
    const provider = createProvider('anthropic', 'sk-ant-test', { baseUrl });
    const result = await provider.chat({
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'You are a categorizer.' },
        { role: 'user', content: 'categorize this' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'toolu_0', name: 'get_transaction', arguments: { id: 't1' } }] },
        { role: 'tool', toolCallId: 'toolu_0', content: '{"payee":"Uber"}' },
        { role: 'tool', toolCallId: 'toolu_0b', content: '{"payee":"99"}' },
        { role: 'user', content: 'and now?' },
      ],
      tools: [{ name: 'list_categories', description: 'List categories', parameters: { type: 'object' } }],
      jsonSchema: { name: 'suggestions', schema: { type: 'object', properties: {} } },
      temperature: 0.1,
      maxTokens: 512,
    });

    const request = captured[0]!;
    expect(request.path).toBe('/messages');
    expect(request.headers['x-api-key']).toBe('sk-ant-test');
    expect(request.headers['anthropic-version']).toBe('2026-10-21');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body).toMatchObject({
      model: 'claude-test',
      max_tokens: 512,
      temperature: 0.1,
      system: 'You are a categorizer.',
      tools: [{ name: 'list_categories', description: 'List categories', input_schema: { type: 'object' } }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: {} } } },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'categorize this' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_0', name: 'get_transaction', input: { id: 't1' } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_0', content: '{"payee":"Uber"}' },
            { type: 'tool_result', tool_use_id: 'toolu_0b', content: '{"payee":"99"}' },
            { type: 'text', text: 'and now?' },
          ],
        },
      ],
    });

    expect(result.text).toBe('Let me check.');
    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'list_categories', arguments: { budget_id: 'b1' } }]);
    expect(result.finishReason).toBe('tool_use');
  });

  test('a plain JSON-mode turn (no tools) uses max_tokens default and no output_config when unset', async () => {
    const baseUrl = stub(() => Response.json({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }));
    const result = await createProvider('anthropic', 'sk-ant-test', { baseUrl }).chat({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(captured[0]!.body).toMatchObject({ max_tokens: 4096 });
    expect(captured[0]!.body).not.toHaveProperty('output_config');
    expect(result.text).toBe('hi');
    expect(result.finishReason).toBe('end_turn');
  });
});

describe('Anthropic model listing', () => {
  test('walks has_more pages with after_id, maps display_name, sorts', async () => {
    let page = 0;
    const baseUrl = stub(() => {
      page += 1;
      if (page === 1) {
        return Response.json({ data: [{ id: 'claude-b', display_name: 'Claude B' }], has_more: true, last_id: 'claude-b' });
      }
      return Response.json({ data: [{ id: 'claude-a' }], has_more: false, last_id: 'claude-a' });
    });
    const models = await createProvider('anthropic', 'sk-ant-test', { baseUrl }).listModels();
    expect(captured[0]!.path).toBe('/models?limit=100');
    expect(captured[1]!.path).toBe('/models?limit=100&after_id=claude-b');
    expect(models).toEqual([
      { id: 'claude-a', name: 'claude-a', contextLength: null },
      { id: 'claude-b', name: 'Claude B', contextLength: null },
    ]);
  });
});

describe('Anthropic errors', () => {
  test('401 is an auth rejection', async () => {
    const baseUrl = stub(() => Response.json({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }));
    await expect(createProvider('anthropic', 'bad', { baseUrl }).listModels()).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  test('content without a content array is bad_response', async () => {
    const baseUrl = stub(() => Response.json({ stop_reason: 'end_turn' }));
    await expect(createProvider('anthropic', 'key', { baseUrl }).chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });
});
