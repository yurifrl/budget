/**
 * The AI port — the only surface the rest of the server (routes, the
 * categorizer, Temporal activities) is allowed to know about.
 *
 * A provider is integrated by implementing `AiProvider` in its own folder
 * under `./providers/` and registering it in `./providers/index.ts` (one line
 * per provider). Everything provider-specific — request/response shapes, auth
 * headers, structured-output spelling, model-list quirks — stays inside the
 * adapter; this file stays provider-neutral.
 */
import type { AiProviderId } from '@shared/contracts/ai';

/** One tool call the model asked for, arguments already parsed. */
export type AiToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

/**
 * One turn of a conversation. `tool` carries a tool result back to the model
 * and must name the `toolCallId` it answers. An assistant turn may carry text,
 * tool calls, or both.
 *
 * `rawContent` is the provider-native content blocks of an answer (from
 * `AiChatResult.rawContent`). When set, the adapter sends it back verbatim as
 * the assistant turn — Anthropic requires its thinking blocks to come back
 * unmodified in a tool loop. Providers that need no echo leave it unset.
 */
export type AiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: AiToolCall[]; rawContent?: unknown[] }
  | { role: 'tool'; toolCallId: string; content: string };

/** A function the model may call. `parameters` is a JSON Schema object. */
export type AiTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/**
 * Ask for the final answer as JSON matching this schema. `name` labels the
 * schema at providers that require a name. Adapters map it to
 * response_format (OpenAI/OpenRouter), output_config (Anthropic) or JSON mode
 * plus a schema instruction (DeepSeek/Z.ai); the caller still validates the
 * result with zod, since not every provider guarantees schema adherence.
 * OpenAI-family strict mode wants an object schema with every property
 * required and `additionalProperties: false` — build it that way.
 */
export type AiJsonSchema = {
  name: string;
  schema: Record<string, unknown>;
};

export type AiChatRequest = {
  model: string;
  messages: AiMessage[];
  tools?: AiTool[];
  jsonSchema?: AiJsonSchema | null;
  /** Dropped by adapters whose pinned API version removed sampling parameters (Anthropic 2026-10-21). */
  temperature?: number;
  /** Upper bound of the answer (thinking tokens included). Adapters pick a documented default when omitted. */
  maxTokens?: number;
  /**
   * Caller cancellation (for example a cancelled Temporal activity). The
   * adapter combines it with its deadline; either rejects with
   * `AiProviderError` kind `timeout`. Retry policy stays with the caller.
   */
  signal?: AbortSignal;
};

/** Tokens the provider billed for one chat call, as reported by the provider. */
export type AiTokenUsage = {
  input: number;
  output: number;
};

export type AiChatResult = {
  /** Assistant text; null when the turn was tool calls only. */
  text: string | null;
  toolCalls: AiToolCall[];
  /**
   * Provider-native content blocks of this answer, to echo back on the next
   * turn (Anthropic thinking blocks are required for tool loops). Absent when
   * the provider needs no echo.
   */
  rawContent?: unknown[];
  /** The model the provider says it answered with (falls back to the request's). */
  model: string;
  /** Provider's stop reason, verbatim (`stop`, `tool_use`, `length`, ...), for logs. */
  finishReason: string | null;
  /**
   * Tokens the provider billed for this call. Absent/null when the provider
   * reported no usage (or only one side); callers that report cost must not
   * invent a number.
   */
  usage?: AiTokenUsage | null;
};

export type AiModel = {
  id: string;
  /** Human label from the provider; the adapter falls back to `id`. */
  name: string;
  contextLength: number | null;
};

/** The provider-neutral AI port. */
export interface AiProvider {
  readonly id: AiProviderId;
  /**
   * One chat completion, with optional tool calls and structured output.
   * A deadline or a `signal` abort rejects with `AiProviderError` kind
   * `timeout`; the caller decides whether to retry (a non-streaming
   * generation may already have been billed).
   */
  chat(request: AiChatRequest): Promise<AiChatResult>;
  /**
   * Prove the key is accepted with an authenticated request. Most checks are
   * side-effect-free; Z.ai has no model-list endpoint and checks with a small
   * paid chat completion (`max_tokens: 1`), so it is a real, billable call.
   * Throws `AiProviderError('auth')` when the provider refuses it. A model
   * list is NOT a check on every provider: OpenRouter's is public. Adapters
   * know their own authenticated endpoint. `model` lets a provider whose
   * check is a chat call (Z.ai) use the model the user chose; model-list
   * checks ignore it.
   *
   * Returns the models the check already fetched when the check IS the model
   * list (OpenAI, DeepSeek, Anthropic) or the provider's documented suggestion
   * list after a successful chat check (Z.ai), so callers that also need the
   * list do not ask twice; null when the check was something else (OpenRouter
   * `/key`).
   */
  verifyKey(model?: string): Promise<AiModel[] | null>;
  /** Every model this key can chat with, sorted by id. */
  listModels(): Promise<AiModel[]>;
}
