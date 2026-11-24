/**
 * OpenAI-compatible chat adapter, shared by four providers: OpenRouter,
 * OpenAI, DeepSeek and Z.ai. They differ in base URL, auth (all bearer), the
 * token-limit parameter name, and how strictly they accept a JSON schema as a
 * response format — the table lives in ./index.ts, not here.
 *
 * Provider payloads are validated by hand (`asRecord` + narrow checks) instead
 * of zod: the adapter only needs the few fields it maps onto the port, and an
 * unexpected extra field must never break a chat.
 */
import type { AiProviderId } from '@shared/contracts/ai';

import { AiProviderError } from '../errors';
import { DEFAULT_CHAT_TIMEOUT_MS, DEFAULT_MODELS_TIMEOUT_MS, requestJson, type FetchLike } from '../http';
import type { AiChatRequest, AiChatResult, AiJsonSchema, AiModel, AiProvider, AiToolCall } from '../types';

export type StructuredOutput = 'json_schema' | 'json_object';

export type OpenAiCompatibleConfig = {
  id: AiProviderId;
  /** Name used in error messages ("OpenRouter API 429: ..."). */
  label: string;
  baseUrl: string;
  /** json_schema = response_format json_schema; json_object = JSON mode + schema in a system message. */
  structured: StructuredOutput;
  /** OpenAI's newer models want max_completion_tokens; the other three accept max_tokens. */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
};

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null);

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: AiProviderId;

  constructor(
    private readonly config: OpenAiCompatibleConfig,
    private readonly apiKey: string,
    private readonly fetchImpl?: FetchLike,
  ) {
    this.id = config.id;
  }

  private get auth(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  async chat(request: AiChatRequest): Promise<AiChatResult> {
    const body: Json = { model: request.model, messages: this.wireMessages(request) };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body[this.config.tokenParam] = request.maxTokens;
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }
    if (request.jsonSchema) this.applyStructured(body, request.jsonSchema);
    const json = await requestJson({
      provider: this.id,
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      method: 'POST',
      headers: this.auth,
      body,
      timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
      fetch: this.fetchImpl,
    });
    return this.parseChat(json, request.model);
  }

  async listModels(): Promise<AiModel[]> {
    const json = await requestJson({
      provider: this.id,
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/models`,
      headers: this.auth,
      timeoutMs: DEFAULT_MODELS_TIMEOUT_MS,
      fetch: this.fetchImpl,
    });
    const data = Array.isArray(asRecord(json)?.data) ? (asRecord(json)!.data as unknown[]) : null;
    if (!data) throw new AiProviderError('bad_response', `${this.config.label} answered the model list without a data array`);
    const models: AiModel[] = [];
    for (const entry of data) {
      const model = asRecord(entry);
      if (typeof model?.id !== 'string' || !model.id) continue;
      const context = model.context_length ?? model.context_window;
      models.push({
        id: model.id,
        name: typeof model.name === 'string' && model.name.trim() ? model.name : model.id,
        contextLength: typeof context === 'number' && Number.isFinite(context) ? Math.trunc(context) : null,
      });
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  private wireMessages(request: AiChatRequest): unknown[] {
    const messages = request.messages.map((message) => {
      if (message.role === 'system' || message.role === 'user') return { role: message.role, content: message.content };
      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: message.content,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        };
      }
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    });
    if (request.jsonSchema && this.config.structured === 'json_object') {
      messages.unshift({
        role: 'system',
        content:
          `Answer with a single JSON object that validates against this JSON Schema (${request.jsonSchema.name}): ` +
          `${JSON.stringify(request.jsonSchema.schema)}. Do not add Markdown fences or any text outside the object.`,
      });
    }
    return messages;
  }

  private applyStructured(body: Json, jsonSchema: AiJsonSchema): void {
    body.response_format =
      this.config.structured === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: jsonSchema.name, schema: jsonSchema.schema, strict: true } }
        : { type: 'json_object' };
  }

  private parseChat(json: unknown, requestedModel: string): AiChatResult {
    const root = asRecord(json);
    const choice = Array.isArray(root?.choices) ? asRecord((root!.choices as unknown[])[0]) : null;
    if (!choice) throw new AiProviderError('bad_response', `${this.config.label} answered without a chat choice`);
    const message = asRecord(choice.message) ?? {};
    const content = message.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => (typeof asRecord(part)?.text === 'string' ? (asRecord(part)!.text as string) : '')).join('')
          : null;
    return {
      text: text === '' ? null : text,
      toolCalls: this.parseToolCalls(message.tool_calls),
      model: typeof root?.model === 'string' ? root.model : requestedModel,
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    };
  }

  private parseToolCalls(raw: unknown): AiToolCall[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((entry, index) => {
      const call = asRecord(entry);
      const fn = asRecord(call?.function);
      if (typeof call?.id !== 'string' || !call.id || typeof fn?.name !== 'string' || !fn.name) {
        throw new AiProviderError('bad_response', `${this.config.label} returned a tool call without id or name`);
      }
      let args: Record<string, unknown> = {};
      if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
        try {
          const parsed: unknown = JSON.parse(fn.arguments);
          const record = asRecord(parsed);
          if (!record) throw new Error('not an object');
          args = record;
        } catch {
          throw new AiProviderError('bad_response', `${this.config.label} returned tool call ${index} arguments that are not a JSON object`);
        }
      } else if (asRecord(fn.arguments)) {
        args = asRecord(fn.arguments)!;
      }
      return { id: call.id, name: fn.name, arguments: args };
    });
  }
}
