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
import { chatTimeoutMs, DEFAULT_MODELS_TIMEOUT_MS, requestJson, type FetchLike } from '../http';
import type { AiChatRequest, AiChatResult, AiJsonSchema, AiModel, AiProvider, AiToolCall } from '../types';
import { tokenUsage } from './usage';

export type StructuredOutput = 'json_schema' | 'json_object';

/**
 * The authenticated call that proves a key is accepted. The model is the
 * caller's chosen id for providers whose check is a chat call (Z.ai); it is
 * ignored by fixed checks such as `/key` and `/models`.
 */
export type KeyCheck = (model: string | null) => {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
};

/**
 * How this provider documents reasoning effort:
 *  - `reasoning_effort`: the OpenAI Chat Completions field, also documented by
 *    DeepSeek and Z.ai (GLM-5.3);
 *  - `openrouter`: OpenRouter's normalized `reasoning: { effort }` map.
 * Omitted entirely by providers that document neither.
 */
export type ReasoningEffortParam = 'reasoning_effort' | 'openrouter';

export type OpenAiCompatibleConfig = {
  id: AiProviderId;
  /** Name used in error messages ("OpenRouter API 429: ..."). */
  label: string;
  baseUrl: string;
  /** /key on OpenRouter, /models elsewhere, the cheapest chat call on Z.ai. */
  keyCheck: KeyCheck;
  /** Providers with no documented model-list endpoint (Z.ai): their documented chat models. */
  staticModels?: readonly AiModel[];
  /** json_schema = response_format json_schema; json_object = JSON mode + schema in a system message. */
  structured: StructuredOutput;
  /** OpenAI's newer models want max_completion_tokens; the other three accept max_tokens. */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  /**
   * Whether the provider documents `tool_choice: "none"` (OpenAI family:
   * function-calling guide; DeepSeek: chat-completion reference). Z.ai's
   * OpenAPI documents only `"auto"` (`docs.z.ai/openapi.json`), so its entry
   * sets false and the adapter keeps `tools` without a choice.
   */
  toolChoiceNone?: boolean;
  /** Drop ids this provider lists but this adapter cannot chat with (OpenAI's embeddings, audio, image). */
  filterModel?: (id: string) => boolean;
  /**
   * Documented reasoning-effort parameter. Absent = the provider documents
   * none here and the field is omitted.
   */
  reasoningEffort?: ReasoningEffortParam;
  /**
   * Models that document the parameter (default: all). OpenAI supports
   * `reasoning_effort` only on reasoning models; Z.ai documents it on GLM-5.3.
   */
  supportsReasoningEffort?: (id: string) => boolean;
};

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null);

/**
 * OpenAI's /models has no capability field and includes embedding, audio,
 * image, search and moderation models. This adapter only speaks Chat
 * Completions and the categorizer needs tool calling, so keep the chat
 * families and drop the known non-chat ones.
 *
 * Docs (2026-11-24): `gpt-4o-search-preview`, `gpt-4o-mini-search-preview` and
 * `chatgpt-4o-latest` are shut down and their supported-feature lists omit
 * function calling; `babbage-002`/`davinci-002` support legacy Completions
 * only (Chat Completions: not supported). Dropped: `*-pro` and `*-codex`
 * (Responses API only), `gpt-3.5-turbo-instruct` and the legacy Completions
 * fine-tunes.
 *
 * Fine-tunes are otherwise kept: `ft:<base>:<org>:<suffix>:<id>` works with
 * Chat Completions, and the org/suffix may contain `-pro-` or `-image-`, so
 * only the base model is checked. Heuristic by design: an unknown new chat
 * family is dropped, never a non-chat one added.
 */
const OPENAI_COMPLETIONS_FINE_TUNE = /^ft:(?:babbage-002|davinci-002|gpt-3\.5-turbo-instruct)(?:$|:)/;
const OPENAI_NON_CHAT =
  /(^|[-/])(?:embedding|moderation|tts|whisper|transcribe|audio|realtime|image|sora|dall-e|codex|deep-research|instruct|pro|search-preview|chatgpt)(?:$|[-/])/;
const OPENAI_CHAT_FAMILY = /^(?:gpt-|o\d|ft:)/;

/**
 * Chat models whose API documents `reasoning_effort`
 * (developers.openai.com/api/docs/guides/reasoning, Chat Completions): the
 * gpt-5+ families and the o-series. Earlier gpt-4 models and fine-tunes do not
 * document it, so the adapter omits the field for them.
 */
export function isOpenAiReasoningModel(id: string): boolean {
  return !id.startsWith('ft:') && /^(?:gpt-[5-9]|o\d)/.test(id);
}

export function isOpenAiChatModel(id: string): boolean {
  if (OPENAI_COMPLETIONS_FINE_TUNE.test(id)) return false;
  if (id.startsWith('ft:')) return !OPENAI_NON_CHAT.test(id.split(':')[1] ?? '');
  return OPENAI_CHAT_FAMILY.test(id) && !OPENAI_NON_CHAT.test(id);
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: AiProviderId;
  readonly #apiKey: string;

  constructor(
    private readonly config: OpenAiCompatibleConfig,
    apiKey: string,
    private readonly fetchImpl?: FetchLike,
  ) {
    this.id = config.id;
    this.#apiKey = apiKey;
  }

  private get auth(): Record<string, string> {
    return { authorization: `Bearer ${this.#apiKey}` };
  }

  async chat(request: AiChatRequest): Promise<AiChatResult> {
    const body: Json = { model: request.model, messages: this.wireMessages(request) };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body[this.config.tokenParam] = request.maxTokens;
    if (
      request.reasoningEffort &&
      this.config.reasoningEffort &&
      (this.config.supportsReasoningEffort?.(request.model) ?? true)
    ) {
      if (this.config.reasoningEffort === 'openrouter') body.reasoning = { effort: request.reasoningEffort };
      else body.reasoning_effort = request.reasoningEffort;
    }
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      if (request.toolChoice === 'none' && this.config.toolChoiceNone !== false) body.tool_choice = 'none';
    }
    if (request.jsonSchema) this.applyStructured(body, request.jsonSchema);
    const json = await requestJson({
      provider: this.id,
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      method: 'POST',
      headers: this.auth,
      body,
      timeoutMs: chatTimeoutMs(request.maxTokens),
      timeoutKind: 'timeout',
      signal: request.signal,
      disableSocketIdleTimeout: true,
      fetch: this.fetchImpl,
    });
    return this.parseChat(json, request.model);
  }

  async verifyKey(model?: string): Promise<AiModel[] | null> {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const check = this.config.keyCheck(model ?? null);
    const json = await requestJson({
      provider: this.id,
      url: `${base}${check.path}`,
      method: check.method ?? 'GET',
      headers: this.auth,
      body: check.body,
      timeoutMs: DEFAULT_MODELS_TIMEOUT_MS,
      fetch: this.fetchImpl,
    });
    // Only /models answers a list; /key (OpenRouter) and the chat check (Z.ai)
    // do not. Z.ai returns its documented suggestion list after the check.
    if (check.path === '/models') return this.parseModels(json);
    return this.config.staticModels ? [...this.config.staticModels].sort((a, b) => a.id.localeCompare(b.id)) : null;
  }

  async listModels(): Promise<AiModel[]> {
    // No documented model-list endpoint (Z.ai): return the documented chat
    // models, so save/test can still validate a picked model.
    if (this.config.staticModels) return [...this.config.staticModels].sort((a, b) => a.id.localeCompare(b.id));
    const json = await requestJson({
      provider: this.id,
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/models`,
      headers: this.auth,
      timeoutMs: DEFAULT_MODELS_TIMEOUT_MS,
      fetch: this.fetchImpl,
    });
    return this.parseModels(json);
  }

  private parseModels(json: unknown): AiModel[] {
    const data = Array.isArray(asRecord(json)?.data) ? (asRecord(json)!.data as unknown[]) : null;
    if (!data) throw new AiProviderError('bad_response', `${this.config.label} answered the model list without a data array`, null, null, this.id);
    const models: AiModel[] = [];
    for (const entry of data) {
      const model = asRecord(entry);
      if (typeof model?.id !== 'string' || !model.id) continue;
      if (this.config.filterModel && !this.config.filterModel(model.id)) continue;
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
    if (!choice) throw new AiProviderError('bad_response', `${this.config.label} answered without a chat choice`, null, null, this.id);
    const message = asRecord(choice.message) ?? {};
    const content = message.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => (typeof asRecord(part)?.text === 'string' ? (asRecord(part)!.text as string) : '')).join('')
          : null;
    const usage = asRecord(root?.usage);
    return {
      text: text === '' ? null : text,
      toolCalls: this.parseToolCalls(message.tool_calls),
      model: typeof root?.model === 'string' ? root.model : requestedModel,
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      usage: tokenUsage(usage?.prompt_tokens, usage?.completion_tokens),
    };
  }

  private parseToolCalls(raw: unknown): AiToolCall[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((entry, index) => {
      const call = asRecord(entry);
      const fn = asRecord(call?.function);
      if (typeof call?.id !== 'string' || !call.id || typeof fn?.name !== 'string' || !fn.name) {
        throw new AiProviderError('bad_response', `${this.config.label} returned a tool call without id or name`, null, null, this.id);
      }
      let args: Record<string, unknown> = {};
      if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
        try {
          const parsed: unknown = JSON.parse(fn.arguments);
          const record = asRecord(parsed);
          if (!record) throw new Error('not an object');
          args = record;
        } catch {
          throw new AiProviderError('bad_response', `${this.config.label} returned tool call ${index} arguments that are not a JSON object`, null, null, this.id);
        }
      } else if (asRecord(fn.arguments)) {
        args = asRecord(fn.arguments)!;
      }
      return { id: call.id, name: fn.name, arguments: args };
    });
  }
}
