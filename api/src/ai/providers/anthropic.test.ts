/**
 * Anthropic adapter against a local stub HTTP server: Messages API mapping
 * (system, tool_use/tool_result blocks, structured output), model pagination
 * and error mapping. No real provider is called.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Server } from 'bun';
import type { AiProviderId } from '@shared/contracts/ai';

import type { FetchInit, FetchLike } from '../http';
import { builtinProviders, makeResolvedAiKey, providerFor, setProviders, type ProviderOptions } from './index';

const createProvider = (id: AiProviderId, apiKey: string, options?: ProviderOptions) => {
  setProviders({
    ...builtinProviders,
    [id]: { ...builtinProviders[id], create: (key: string) => builtinProviders[id].create(key, options) },
  });
  return providerFor(makeResolvedAiKey({ source: 'own', provider: id, model: null, apiKey, updatedAt: null }));
};

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
  setProviders(null);
  await stopStub();
});

async function stopStub(): Promise<void> {
  const current = server;
  server = null;
  if (current) await current.stop(true);
}

describe('Anthropic chat request', () => {
  test('system, tool blocks, structured output and headers map to the Messages API', async () => {
    // 2026-10-21 rejects sampling parameters with a 400, so the stub does too.
    const baseUrl = stub((_req, body) => {
      const sent = body as Record<string, unknown>;
      if ('temperature' in sent || 'top_p' in sent || 'top_k' in sent) {
        return Response.json({ error: { type: 'invalid_request_error', message: 'sampling parameters are not supported' } }, { status: 400 });
      }
      return Response.json({
        model: 'claude-test',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'list_categories', input: { budget_id: 'b1' } },
        ],
      });
    });
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
    expect(request.body).not.toHaveProperty('temperature');
    expect(request.body).not.toHaveProperty('top_p');
    expect(request.body).not.toHaveProperty('top_k');

    expect(result.text).toBe('Let me check.');
    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'list_categories', arguments: { budget_id: 'b1' } }]);
    expect(result.finishReason).toBe('tool_use');
  });

  test('a plain turn with no tools uses the thinking-ready max_tokens default and no output_config when unset', async () => {
    const baseUrl = stub(() => Response.json({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }));
    const result = await createProvider('anthropic', 'sk-ant-test', { baseUrl }).chat({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(captured[0]!.body).toMatchObject({ max_tokens: 16_000 });
    expect(captured[0]!.body).not.toHaveProperty('output_config');
    expect(result.text).toBe('hi');
    expect(result.finishReason).toBe('end_turn');
    expect(result.usage).toBeNull();
  });

  test('maps Anthropic input/output tokens onto the port', async () => {
    const baseUrl = stub(() =>
      Response.json({
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 21, output_tokens: 43 },
      }),
    );
    const result = await createProvider('anthropic', 'sk-ant-test', { baseUrl }).chat({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.usage).toEqual({ input: 21, output: 43 });
  });

  test('a tool loop echoes thinking blocks back unchanged', async () => {
    const thinking = { type: 'thinking', thinking: 'reasoning summary', signature: 'sig-1' };
    const text = { type: 'text', text: 'Checking.' };
    const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 't1' } };
    const baseUrl = stub(() =>
      Response.json({ model: 'claude-test', stop_reason: 'tool_use', content: [thinking, text, toolUse] }),
    );
    const provider = createProvider('anthropic', 'sk-ant-test', { baseUrl });
    const first = await provider.chat({ model: 'claude-test', messages: [{ role: 'user', content: 'go' }] });
    expect(first.rawContent).toEqual([thinking, text, toolUse]);

    await provider.chat({
      model: 'claude-test',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: first.text, toolCalls: first.toolCalls, rawContent: first.rawContent },
        { role: 'tool', toolCallId: 'toolu_1', content: '{"ok":true}' },
      ],
    });
    const second = captured[1]!.body as { messages: Array<{ role: string; content: unknown }> };
    expect(second.messages[1]).toEqual({ role: 'assistant', content: [thinking, text, toolUse] });
    expect(second.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }],
    });
  });
});

describe('Anthropic key check', () => {
  test('verifyKey is the authenticated Models list, returned so save/test use one call', async () => {
    const baseUrl = stub(() =>
      Response.json({
        data: [{ id: 'claude-a', display_name: 'Claude A', max_input_tokens: 1000 }],
        has_more: false,
        last_id: 'claude-a',
      }),
    );
    const models = await createProvider('anthropic', 'sk-ant-test', { baseUrl }).verifyKey();
    expect(models).toEqual([{ id: 'claude-a', name: 'Claude A', contextLength: 1000 }]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.path).toBe('/models?limit=100');
    expect(captured[0]!.headers['x-api-key']).toBe('sk-ant-test');
  });

  test('a refused key fails verifyKey as auth', async () => {
    const baseUrl = stub(() => Response.json({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }));
    await expect(createProvider('anthropic', 'bad', { baseUrl }).verifyKey()).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });
});

describe('Anthropic chat deadline and cancellation', () => {
  test('the deadline follows the 16k cap (640 s) and disables Bun\'s idle timer', async () => {
    const seen: number[] = [];
    let init: FetchInit | undefined;
    const fetchImpl: FetchLike = async (_input, requestInit) => {
      init = requestInit;
      return Response.json({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
    };
    const spy = spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);
      return new AbortController().signal;
    });
    try {
      const provider = createProvider('anthropic', 'sk-ant-test', { baseUrl: 'https://stub.test', fetch: fetchImpl });
      await provider.chat({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16_000 });
      await provider.chat({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] });
    } finally {
      spy.mockRestore();
    }
    // A fixed 60 s deadline (or a 60 s floor when maxTokens is unset) fails here.
    expect(seen).toEqual([640_000, 640_000]);
    expect(init?.timeout).toBe(false);
  });

  test('a caller abort reaches the chat fetch and rejects as timeout', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = (_input, requestInit) =>
      new Promise((_resolve, reject) => {
        requestInit!.signal!.addEventListener('abort', () => reject(requestInit!.signal!.reason));
        queueMicrotask(() => controller.abort());
      });
    const failure = await createProvider('anthropic', 'sk-ant-test', { baseUrl: 'https://stub.test', fetch: fetchImpl })
      .chat({ model: 'claude-test', messages: [], signal: controller.signal })
      .catch((err: unknown) => err);
    expect(failure).toMatchObject({ kind: 'timeout', provider: 'anthropic' });
  });
});

describe('Anthropic model listing', () => {
  test('walks has_more pages with after_id, maps display_name and max_input_tokens, sorts', async () => {
    let page = 0;
    const baseUrl = stub(() => {
      page += 1;
      if (page === 1) {
        return Response.json({
          data: [{ id: 'claude-b', display_name: 'Claude B', max_input_tokens: 200_000 }],
          has_more: true,
          last_id: 'claude-b',
        });
      }
      return Response.json({ data: [{ id: 'claude-a', max_input_tokens: null }], has_more: false, last_id: 'claude-a' });
    });
    const models = await createProvider('anthropic', 'sk-ant-test', { baseUrl }).listModels();
    expect(captured[0]!.path).toBe('/models?limit=100');
    expect(captured[1]!.path).toBe('/models?limit=100&after_id=claude-b');
    expect(models).toEqual([
      { id: 'claude-a', name: 'claude-a', contextLength: null },
      { id: 'claude-b', name: 'Claude B', contextLength: 200_000 },
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

describe('Anthropic tool history and the final structured turn', () => {
  test('a tool_use history without tools is rejected like the documented API; the adapter keeps them', async () => {
    // Anthropic's handle-tool-calls doc: "Send the request with the same
    // `tools` as the first request" while tool_use blocks are in the history.
    const baseUrl = stub((_req, body) => {
      if (typeof body !== 'object' || body === null || !('messages' in body) || !Array.isArray(body.messages)) {
        return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'no messages' } }, { status: 400 });
      }
      const hasToolUse = body.messages.some((message: unknown) => {
        if (typeof message !== 'object' || message === null || !('content' in message) || !Array.isArray(message.content)) return false;
        return message.content.some((block: unknown) => typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_use');
      });
      const hasTools = 'tools' in body && Array.isArray(body.tools) && body.tools.length > 0;
      if (hasToolUse && !hasTools) {
        return Response.json(
          { type: 'error', error: { type: 'invalid_request_error', message: 'tool_use ids were found without tool_result blocks' } },
          { status: 400 },
        );
      }
      return Response.json({
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"suggestions":[]}' }],
      });
    });
    const provider = createProvider('anthropic', 'sk-ant-test', { baseUrl });
    const result = await provider.chat({
      model: 'claude-test',
      messages: [
        { role: 'user', content: 'categorize this' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'toolu_1', name: 'list_categories', arguments: {} }] },
        { role: 'tool', toolCallId: 'toolu_1', content: '{"groups":[]}' },
        { role: 'user', content: 'answer now with JSON, do not call tools' },
      ],
      tools: [{ name: 'list_categories', description: 'List categories', parameters: { type: 'object' } }],
      toolChoice: 'none',
      jsonSchema: { name: 'category_suggestions', schema: { type: 'object' } },
      maxTokens: 1024,
    });

    expect(result.text).toBe('{"suggestions":[]}');
    const body = captured[0]!.body;
    expect(body).toMatchObject({
      max_tokens: 1024,
      tools: [{ name: 'list_categories', description: 'List categories', input_schema: { type: 'object' } }],
      tool_choice: { type: 'none' },
    });
  });
});
