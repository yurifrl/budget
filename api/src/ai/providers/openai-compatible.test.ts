/**
 * OpenAI-compatible adapters against a local stub HTTP server: the request
 * each provider sends (auth, token param, structured-output spelling, tools)
 * and how responses/errors are parsed. No real provider is ever called.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Server } from 'bun';
import type { AiProviderId } from '@shared/contracts/ai';

import { AiProviderError } from '../errors';
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
  setProviders(null);
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
    // The reply carries no usage block: the port reports null, never a guess.
    expect(result.usage).toBeNull();
  });

  test('maps provider token usage onto the port', async () => {
    const baseUrl = stub(() =>
      Response.json({
        model: 'stub-model',
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      }),
    );
    const result = await createProvider('openai', 'sk-test-123', { baseUrl }).chat({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.usage).toEqual({ input: 12, output: 34 });
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

describe('OpenAI-compatible chat deadline and cancellation', () => {
  test('the deadline follows the cap and a caller abort rejects as timeout', async () => {
    const seen: number[] = [];
    let init: FetchInit | undefined;
    const fetchImpl: FetchLike = async (_input, requestInit) => {
      init = requestInit;
      return chatReply({ content: 'hi' });
    };
    const spy = spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);
      return new AbortController().signal;
    });
    try {
      await createProvider('openai', 'key', { baseUrl: 'https://stub.test', fetch: fetchImpl }).chat({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 16_000,
      });
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([640_000]);
    expect(init?.timeout).toBe(false);

    const controller = new AbortController();
    const aborting: FetchLike = (_input, requestInit) =>
      new Promise((_resolve, reject) => {
        requestInit!.signal!.addEventListener('abort', () => reject(requestInit!.signal!.reason));
        queueMicrotask(() => controller.abort());
      });
    const failure = await createProvider('openai', 'key', { baseUrl: 'https://stub.test', fetch: aborting })
      .chat({ model: 'm', messages: [], signal: controller.signal })
      .catch((err: unknown) => err);
    expect(failure).toMatchObject({ kind: 'timeout', provider: 'openai' });
  });
});

describe('OpenAI-compatible model listing', () => {
  test('asks /models with bearer auth and parses id/name/context_length, sorted', async () => {
    const baseUrl = stub(() =>
      Response.json({
        data: [{ id: 'gpt-b', name: 'Bee', context_length: 128_000 }, { id: 'gpt-a' }, { id: 42 }],
      }),
    );
    for (const id of ['openai', 'openrouter', 'deepseek'] as const) {
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

  test('openai drops non-chat and tool-less models but keeps chat fine-tunes', async () => {
    const data = [
      { id: 'gpt-4.1' },
      { id: 'o3-mini' },
      // Shut down and their supported-feature lists omit function calling.
      { id: 'chatgpt-4o-latest' },
      { id: 'gpt-4o-search-preview' },
      { id: 'gpt-4o-mini-search-preview' },
      // Chat fine-tunes; the org/suffix may contain -pro- or -image-.
      { id: 'ft:gpt-4.1-mini:acme::abc123' },
      { id: 'ft:gpt-4o-mini:acme:invoice-pro-v2:abc' },
      { id: 'ft:gpt-4o-mini:acme:image-gen:abc' },
      // Completions-only fine-tunes, and a fine-tune of a tool-less base.
      { id: 'ft:babbage-002:acme::abc' },
      { id: 'ft:davinci-002:acme::abc' },
      { id: 'ft:gpt-4o-search-preview:acme::abc' },
      { id: 'text-embedding-3-small' },
      { id: 'gpt-4o-audio-preview' },
      { id: 'gpt-image-1' },
      { id: 'omni-moderation-latest' },
      { id: 'gpt-5-codex' },
      // Responses API only: o1-pro, o3-pro, gpt-5-pro.
      { id: 'o1-pro' },
      { id: 'o3-pro' },
      { id: 'gpt-5-pro' },
      // Legacy Completions only.
      { id: 'gpt-3.5-turbo-instruct' },
    ];
    const baseUrl = stub(() => Response.json({ data }));
    const models = await createProvider('openai', 'key-123', { baseUrl }).listModels();
    expect(models.map((model) => model.id)).toEqual([
      'ft:gpt-4.1-mini:acme::abc123',
      'ft:gpt-4o-mini:acme:image-gen:abc',
      'ft:gpt-4o-mini:acme:invoice-pro-v2:abc',
      'gpt-4.1',
      'o3-mini',
    ]);
    // The filter is OpenAI's only: another provider's list is passed through.
    captured = [];
    const openrouterModels = await createProvider('openrouter', 'key-123', { baseUrl }).listModels();
    expect(openrouterModels).toHaveLength(data.length);
  });

  test('a model list without data is a bad_response', async () => {
    const baseUrl = stub(() => Response.json({ models: [] }));
    await expect(createProvider('openai', 'key-123', { baseUrl }).listModels()).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('OpenAI-compatible key check', () => {
  test('OpenRouter authenticates with /key; OpenAI and DeepSeek with /models', async () => {
    let baseUrl = stub(() => Response.json({ data: {} }));
    await expect(createProvider('openrouter', 'sk-or-v1-test', { baseUrl }).verifyKey()).resolves.toBeNull();
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.path).toBe('/key');
    expect(captured[0]!.headers.authorization).toBe('Bearer sk-or-v1-test');
    await stopStub();

    for (const id of ['openai', 'deepseek'] as const) {
      baseUrl = stub(() => Response.json({ data: [{ id: 'gpt-a' }] }));
      const checked = await createProvider(id, 'key-123', { baseUrl }).verifyKey();
      expect(captured[0]!.path).toBe('/models');
      expect(captured[0]!.headers.authorization).toBe('Bearer key-123');
      // The check is the authenticated model list, so its models come back
      // instead of being fetched a second time by the caller.
      expect(checked).toEqual([{ id: 'gpt-a', name: 'gpt-a', contextLength: null }]);
      await stopStub();
    }
  });

  test('zai verifies with the cheapest documented chat call and returns its suggestion list', async () => {
    const baseUrl = stub(() => chatReply({ content: 'ok' }));
    const provider = createProvider('zai', 'zai-key-123', { baseUrl });
    const models = await provider.verifyKey('glm-4.7');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.path).toBe('/chat/completions');
    expect(captured[0]!.headers.authorization).toBe('Bearer zai-key-123');
    // The caller's model when there is one; a documented model otherwise.
    expect(captured[0]!.body).toMatchObject({ model: 'glm-4.7', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
    expect(models!.map((model) => model.id)).toEqual([
      'glm-4.6',
      'glm-4.7',
      'glm-5',
      'glm-5.1',
      'glm-5.2',
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.3-flashx',
      'glm-5.3-flashx-legal',
    ]);

    captured = [];
    const withoutModel = await provider.verifyKey();
    expect(withoutModel!.map((model) => model.id)).toHaveLength(9);
    expect(captured[0]!.body).toMatchObject({ model: 'glm-5.3-flash', max_tokens: 1 });

    captured = [];
    await provider.listModels();
    expect(captured).toEqual([]);
  });

  test('an OpenRouter key rejected by /key fails as auth even though /models is public', async () => {
    const baseUrl = stub(() => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }));
    await expect(createProvider('openrouter', 'junk', { baseUrl }).verifyKey()).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  test('a restricted OpenAI key is 401 for the missing scope, so it cannot be saved', async () => {
    // OpenAI error docs: a key without the endpoint's scope is invalid
    // authentication (401), and 403 is a country/region block.
    const baseUrl = stub(() =>
      Response.json(
        { error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.' } },
        { status: 401 },
      ),
    );
    await expect(createProvider('openai', 'sk-restricted', { baseUrl }).verifyKey()).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    });
  });

  test('a 403 proves nothing about the key: OpenAI country blocks and other providers are auth', async () => {
    const baseUrl = stub(() => Response.json({ error: { message: 'unsupported_country_region_territory' } }, { status: 403 }));
    await expect(createProvider('openai', 'sk-any', { baseUrl }).verifyKey()).rejects.toMatchObject({ kind: 'auth', status: 403 });
    await expect(createProvider('deepseek', 'key', { baseUrl }).verifyKey()).rejects.toMatchObject({ kind: 'auth', status: 403 });
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

describe('OpenAI-compatible tool_choice on the final answer turn', () => {
  test('openai: tools stay declared and tool_choice none disallows a new call', async () => {
    const baseUrl = stub(() =>
      chatReply({ content: '{"suggestions":[]}' }),
    );
    const provider = createProvider('openai', 'sk-test-123', { baseUrl });
    await provider.chat({
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'categorize this' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'list_categories', arguments: {} }] },
        { role: 'tool', toolCallId: 'call_1', content: '{"groups":[]}' },
        { role: 'user', content: 'answer now' },
      ],
      tools: [{ name: 'list_categories', description: 'List categories', parameters: { type: 'object' } }],
      toolChoice: 'none',
      jsonSchema: { name: 'category_suggestions', schema: { type: 'object' } },
      maxTokens: 1024,
    });
    expect(captured[0]!.body).toMatchObject({
      max_completion_tokens: 1024,
      tools: [{ type: 'function', function: { name: 'list_categories' } }],
      tool_choice: 'none',
    });
  });

  test('zai: its OpenAPI documents only auto, so tools stay and tool_choice is omitted', async () => {
    const baseUrl = stub(() => chatReply({ content: '{"suggestions":[]}' }));
    const provider = createProvider('zai', 'sk-zai-123', { baseUrl });
    await provider.chat({
      model: 'glm-test',
      messages: [
        { role: 'user', content: 'categorize this' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'list_categories', arguments: {} }] },
        { role: 'tool', toolCallId: 'call_1', content: '{"groups":[]}' },
        { role: 'user', content: 'answer now' },
      ],
      tools: [{ name: 'list_categories', description: 'List categories', parameters: { type: 'object' } }],
      toolChoice: 'none',
      jsonSchema: { name: 'category_suggestions', schema: { type: 'object' } },
      maxTokens: 1024,
    });
    const body = captured[0]!.body;
    expect(body).toMatchObject({ max_tokens: 1024, tools: [{ type: 'function', function: { name: 'list_categories' } }] });
    expect(body).not.toHaveProperty('tool_choice');
  });
});

describe('OpenAI-compatible reasoning effort', () => {
  test('openai sends reasoning_effort for reasoning models and omits it for older chat models', async () => {
    const baseUrl = stub(() => chatReply({ content: 'ok' }));
    const provider = createProvider('openai', 'sk-test-123', { baseUrl });
    await provider.chat({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low' });
    await provider.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low' });
    expect(captured[0]!.body).toMatchObject({ model: 'gpt-5.5', reasoning_effort: 'low' });
    expect(captured[1]!.body).not.toHaveProperty('reasoning_effort');
  });

  test('openrouter uses the documented reasoning map', async () => {
    const baseUrl = stub(() => chatReply({ content: 'ok' }));
    const provider = createProvider('openrouter', 'sk-or-v1-test', { baseUrl });
    await provider.chat({ model: 'some/model', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low' });
    expect(captured[0]!.body).toMatchObject({ reasoning: { effort: 'low' } });
  });

  test('deepseek sends reasoning_effort', async () => {
    const baseUrl = stub(() => chatReply({ content: 'ok' }));
    const provider = createProvider('deepseek', 'sk-ds-test', { baseUrl });
    await provider.chat({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low' });
    expect(captured[0]!.body).toMatchObject({ reasoning_effort: 'low' });
  });

  test('zai documents reasoning_effort on GLM-5.3 only', async () => {
    const baseUrl = stub(() => chatReply({ content: 'ok' }));
    const provider = createProvider('zai', 'zai-key', { baseUrl });
    await provider.chat({ model: 'glm-5.3', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low' });
    await provider.chat({ model: 'glm-4.6', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low' });
    expect(captured[0]!.body).toMatchObject({ reasoning_effort: 'low' });
    expect(captured[1]!.body).not.toHaveProperty('reasoning_effort');
  });

  test('omits the field when the caller does not ask for effort', async () => {
    const baseUrl = stub(() => chatReply({ content: 'ok' }));
    const provider = createProvider('openai', 'sk-test-123', { baseUrl });
    await provider.chat({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }] });
    expect(captured[0]!.body).not.toHaveProperty('reasoning_effort');
  });
});
