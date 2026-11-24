/**
 * OpenAI-compatible adapters against a local stub HTTP server: the request
 * each provider sends (auth, token param, structured-output spelling, tools)
 * and how responses/errors are parsed. No real provider is ever called.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';

import { AiProviderError } from '../errors';
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
      const url = new URL(req.url);
      captured.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(req.headers.entries()),
        body: text ? (JSON.parse(text) as unknown) : null,
      });
      return respond(req, text ? (JSON.parse(text) as unknown) : null);
    },
  });
  return `http://localhost:${server.port}`;
}

afterEach(async () => {
  await stopStub();
});

async function stopStub(): Promise<void> {
  const current = server;
  server = null;
  if (current) await current.stop(true);
}

const chatReply = (message: unknown, extra: Record<string, unknown> = {}) =>
  Response.json({ model: 'stub-model', choices: [{ message, finish_reason: 'stop', ...extra }] });

describe('OpenAI-compatible chat request', () => {
  test('openai: bearer auth, tools, tool results, max_completion_tokens and a strict json schema', async () => {
    const baseUrl = stub(() =>
      chatReply({
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_categories', arguments: '{"budget_id":"b1"}' } }],
      }),
    );
    const provider = createProvider('openai', 'sk-test-123', { baseUrl });
    const result = await provider.chat({
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'categorize' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'call_0', name: 'get_transaction', arguments: { id: 't1' } }] },
        { role: 'tool', toolCallId: 'call_0', content: '{"payee":"Uber"}' },
      ],
      tools: [{ name: 'list_categories', description: 'List categories', parameters: { type: 'object' } }],
      jsonSchema: { name: 'suggestions', schema: { type: 'object', properties: {} } },
      temperature: 0.2,
      maxTokens: 300,
    });

    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.path).toBe('/chat/completions');
    expect(request.method).toBe('POST');
    expect(request.headers.authorization).toBe('Bearer sk-test-123');
    expect(request.body).toMatchObject({
      model: 'gpt-test',
      max_completion_tokens: 300,
      temperature: 0.2,
      tools: [{ type: 'function', function: { name: 'list_categories', description: 'List categories', parameters: { type: 'object' } } }],
      messages: [
        { role: 'user', content: 'categorize' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'get_transaction', arguments: '{"id":"t1"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_0', content: '{"payee":"Uber"}' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'suggestions', schema: { type: 'object', properties: {} }, strict: true },
      },
    });
    expect(request.body).not.toHaveProperty('max_tokens');

    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'list_categories', arguments: { budget_id: 'b1' } }]);
    expect(result.model).toBe('stub-model');
  });

  test('openrouter: max_tokens and json_schema', async () => {
    const baseUrl = stub(() => chatReply({ content: '{"ok":true}' }));
    await createProvider('openrouter', 'sk-or-v1-123', { baseUrl }).chat({
      model: 'some/model',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 99,
      jsonSchema: { name: 's', schema: { type: 'object' } },
    });
    expect(captured[0]!.body).toMatchObject({ max_tokens: 99, response_format: { type: 'json_schema' } });
    expect(captured[0]!.body).not.toHaveProperty('max_completion_tokens');
  });

  test('deepseek and zai: JSON mode plus the schema as a system instruction', async () => {
    for (const id of ['deepseek', 'zai'] as const) {
      const baseUrl = stub(() => chatReply({ content: '{"ok":true}' }));
      const result = await createProvider(id, 'sk-test-123', { baseUrl }).chat({
        model: 'some-model',
        messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'hi' }],
        jsonSchema: { name: 'suggestions', schema: { type: 'object', properties: { a: { type: 'string' } } } },
      });
      expect(captured[0]!.body).toMatchObject({
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: expect.stringContaining('JSON Schema (suggestions)') },
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'hi' },
        ],
      });
      expect(captured[0]!.body).not.toHaveProperty('max_tokens');
      expect(result.text).toBe('{"ok":true}');
      await stopStub();
    }
  });
});

describe('OpenAI-compatible model listing', () => {
  test('asks /models with bearer auth and parses id/name/context_length, sorted', async () => {
    const baseUrl = stub(() =>
      Response.json({
        data: [{ id: 'gpt-b', name: 'Bee', context_length: 128_000 }, { id: 'gpt-a' }, { id: 42 }],
      }),
    );
    for (const id of ['openai', 'openrouter', 'deepseek', 'zai'] as const) {
      const models = await createProvider(id, 'key-123', { baseUrl }).listModels();
      expect(captured[0]!.path).toBe('/models');
      expect(captured[0]!.headers.authorization).toBe('Bearer key-123');
      expect(models).toEqual([
        { id: 'gpt-a', name: 'gpt-a', contextLength: null },
        { id: 'gpt-b', name: 'Bee', contextLength: 128_000 },
      ]);
      captured = [];
    }
  });

  test('openai drops models the Chat Completions API cannot chat with', async () => {
    const baseUrl = stub(() =>
      Response.json({
        data: [
          { id: 'gpt-4.1' },
          { id: 'o3-mini' },
          { id: 'chatgpt-4o-latest' },
          { id: 'text-embedding-3-small' },
          { id: 'gpt-4o-audio-preview' },
          { id: 'gpt-image-1' },
          { id: 'omni-moderation-latest' },
          { id: 'gpt-5-codex' },
        ],
      }),
    );
    const models = await createProvider('openai', 'key-123', { baseUrl }).listModels();
    expect(models.map((model) => model.id)).toEqual(['chatgpt-4o-latest', 'gpt-4.1', 'o3-mini']);
    // The filter is OpenAI's only: another provider's list is passed through.
    captured = [];
    const openrouterModels = await createProvider('openrouter', 'key-123', { baseUrl }).listModels();
    expect(openrouterModels).toHaveLength(8);
  });

  test('a model list without data is a bad_response', async () => {
    const baseUrl = stub(() => Response.json({ models: [] }));
    await expect(createProvider('openai', 'key-123', { baseUrl }).listModels()).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('OpenAI-compatible key check', () => {
  test('OpenRouter authenticates with /key; the others with /models', async () => {
    let baseUrl = stub(() => Response.json({ data: {} }));
    await createProvider('openrouter', 'sk-or-v1-test', { baseUrl }).verifyKey();
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.path).toBe('/key');
    expect(captured[0]!.headers.authorization).toBe('Bearer sk-or-v1-test');
    await stopStub();

    for (const id of ['openai', 'deepseek', 'zai'] as const) {
      baseUrl = stub(() => Response.json({ data: [] }));
      await createProvider(id, 'key-123', { baseUrl }).verifyKey();
      expect(captured[0]!.path).toBe('/models');
      expect(captured[0]!.headers.authorization).toBe('Bearer key-123');
      await stopStub();
    }
  });

  test('an OpenRouter key rejected by /key fails as auth even though /models is public', async () => {
    const baseUrl = stub(() => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }));
    await expect(createProvider('openrouter', 'junk', { baseUrl }).verifyKey()).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });
});

describe('provider error mapping', () => {
  test('401 is an auth rejection with the provider message', async () => {
    const baseUrl = stub(() => Response.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 }));
    const failure = createProvider('openai', 'bad', { baseUrl }).listModels();
    await expect(failure).rejects.toBeInstanceOf(AiProviderError);
    await expect(failure).rejects.toMatchObject({ kind: 'auth', status: 401, message: expect.stringContaining('Incorrect API key') });
  });

  test('429 carries Retry-After; 5xx and network failures are transient', async () => {
    let baseUrl = stub(() => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }));
    await expect(createProvider('openai', 'key', { baseUrl }).chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 7000,
    });
    await stopStub();

    baseUrl = stub(() => new Response('boom', { status: 503 }));
    await expect(createProvider('deepseek', 'key', { baseUrl }).listModels()).rejects.toMatchObject({ kind: 'transient', status: 503 });
    await stopStub();

    await expect(
      createProvider('openai', 'key', { baseUrl: 'http://127.0.0.1:1', fetch: () => Promise.reject(new Error('ECONNREFUSED')) }).listModels(),
    ).rejects.toMatchObject({ kind: 'transient' });
  });

  test('invalid JSON and a chat without choices are bad_response', async () => {
    let baseUrl = stub(() => new Response('not json', { status: 200 }));
    await expect(createProvider('openai', 'key', { baseUrl }).listModels()).rejects.toMatchObject({ kind: 'bad_response' });
    await stopStub();

    baseUrl = stub(() => Response.json({ choices: [] }));
    await expect(createProvider('openai', 'key', { baseUrl }).chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  test('tool arguments that are not JSON are a bad_response', async () => {
    const baseUrl = stub(() => chatReply({ content: null, tool_calls: [{ id: 'c1', function: { name: 'x', arguments: 'not-json' } }] }));
    await expect(createProvider('openai', 'key', { baseUrl }).chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });
});
