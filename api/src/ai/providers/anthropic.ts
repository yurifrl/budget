/**
 * Anthropic Messages adapter. Differences from the OpenAI-compatible family:
 * `x-api-key` + `anthropic-version` headers, a top-level `system` string, tool
 * schemas as `input_schema`, tool results as `tool_result` content blocks in a
 * user turn, and structured output through `output_config.format`.
 */
import { AiProviderError } from '../errors';
import { chatTimeoutMs, DEFAULT_MODELS_TIMEOUT_MS, requestJson, type FetchLike } from '../http';
import type { AiChatRequest, AiChatResult, AiModel, AiProvider, AiToolCall } from '../types';

/** API version that carries structured outputs (`output_config.format`). */
export const ANTHROPIC_VERSION = '2026-10-21';
/**
 * Cap when the caller does not set one. Thinking is on by default on current
 * models and its tokens count toward max_tokens; Anthropic's tool-loop
 * examples use 16000, and a smaller cap can be spent on thinking before the
 * answer. Callers may set a lower cap for a model with a smaller output limit.
 */
const DEFAULT_MAX_TOKENS = 16_000;
/** Anthropic's model list is small; a bounded walk covers it even with pagination. */
const MAX_MODEL_PAGES = 5;

type Json = Record<string, unknown>;
type WireMessage = { role: 'user' | 'assistant'; content: unknown[] };

const asRecord = (value: unknown): Json | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null);

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchImpl?: FetchLike,
    private readonly version = ANTHROPIC_VERSION,
  ) {}

  private get headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey, 'anthropic-version': this.version };
  }

  async chat(request: AiChatRequest): Promise<AiChatResult> {
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    const system = request.messages
      .flatMap((message) => (message.role === 'system' ? [message.content] : []))
      .join('\n\n');
    const body: Json = {
      model: request.model,
      max_tokens: maxTokens,
      messages: this.wireMessages(request.messages),
    };
    if (system) body.system = system;
    // 2026-10-21 rejects temperature/top_p/top_k with a 400 even at defaults.
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    }
    if (request.jsonSchema) body.output_config = { format: { type: 'json_schema', schema: request.jsonSchema.schema } };
    const json = await requestJson({
      provider: this.id,
      url: `${this.baseUrl.replace(/\/+$/, '')}/messages`,
      method: 'POST',
      headers: this.headers,
      body,
      timeoutMs: chatTimeoutMs(maxTokens),
      timeoutKind: 'timeout',
      signal: request.signal,
      disableSocketIdleTimeout: true,
      fetch: this.fetchImpl,
    });
    return this.parseChat(json, request.model);
  }

  /**
   * The authenticated Models call is the key check and costs no inference
   * tokens. Returning its list lets save/test use one call instead of two.
   */
  async verifyKey(): Promise<AiModel[] | null> {
    return this.listModels();
  }

  async listModels(): Promise<AiModel[]> {
    const models: AiModel[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/models`);
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after_id', after);
      const json = await requestJson({
        provider: this.id,
        url: url.toString(),
        headers: this.headers,
        timeoutMs: DEFAULT_MODELS_TIMEOUT_MS,
        fetch: this.fetchImpl,
      });
      const root = asRecord(json);
      const data = Array.isArray(root?.data) ? (root!.data as unknown[]) : null;
      if (!data) throw new AiProviderError('bad_response', 'Anthropic answered the model list without a data array', null, null, this.id);
      for (const entry of data) {
        const model = asRecord(entry);
        if (typeof model?.id !== 'string' || !model.id) continue;
        const context = model.max_input_tokens;
        models.push({
          id: model.id,
          name: typeof model.display_name === 'string' && model.display_name.trim() ? model.display_name : model.id,
          contextLength: typeof context === 'number' && Number.isFinite(context) ? Math.trunc(context) : null,
        });
      }
      const lastId = typeof root?.last_id === 'string' ? root.last_id : (asRecord(data[data.length - 1])?.id as string | undefined);
      if (root?.has_more !== true || !lastId || lastId === after) break;
      after = lastId;
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  private wireMessages(messages: AiChatRequest['messages']): WireMessage[] {
    const out: WireMessage[] = [];
    for (const message of messages) {
      if (message.role === 'system') continue;
      if (message.role === 'user') {
        const last = out[out.length - 1];
        if (last?.role === 'user') last.content.push({ type: 'text', text: message.content });
        else out.push({ role: 'user', content: [{ type: 'text', text: message.content }] });
        continue;
      }
      if (message.role === 'assistant') {
        // Echo the assistant turn exactly as received when continuing a tool
        // loop: thinking blocks (with their signature) must come back intact.
        if (message.rawContent && message.rawContent.length > 0) {
          out.push({ role: 'assistant', content: message.rawContent });
          continue;
        }
        const content: unknown[] = [];
        if (message.content) content.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
        if (content.length > 0) out.push({ role: 'assistant', content });
        continue;
      }
      // A tool result is a user-turn block; consecutive results share the turn.
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content };
      const last = out[out.length - 1];
      if (last?.role === 'user') last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
    return out;
  }

  private parseChat(json: unknown, requestedModel: string): AiChatResult {
    const root = asRecord(json);
    const content = Array.isArray(root?.content) ? (root!.content as unknown[]) : null;
    if (!content) throw new AiProviderError('bad_response', 'Anthropic answered without a content array', null, null, this.id);
    const texts: string[] = [];
    const toolCalls: AiToolCall[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block?.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      } else if (block?.type === 'tool_use') {
        if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) {
          throw new AiProviderError('bad_response', 'Anthropic returned a tool_use block without id or name', null, null, this.id);
        }
        toolCalls.push({ id: block.id, name: block.name, arguments: asRecord(block.input) ?? {} });
      }
    }
    return {
      text: texts.length > 0 ? texts.join('') : null,
      toolCalls,
      rawContent: content,
      model: typeof root?.model === 'string' ? root.model : requestedModel,
      finishReason: typeof root?.stop_reason === 'string' ? root.stop_reason : null,
    };
  }
}
