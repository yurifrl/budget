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
 */
export type AiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: AiToolCall[] }
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
  temperature?: number;
  /** Upper bound of the answer. Adapters pick a safe default when omitted. */
  maxTokens?: number;
};

export type AiChatResult = {
  /** Assistant text; null when the turn was tool calls only. */
  text: string | null;
  toolCalls: AiToolCall[];
  /** The model the provider says it answered with (falls back to the request's). */
  model: string;
  /** Provider's stop reason, verbatim (`stop`, `tool_use`, `length`, ...), for logs. */
  finishReason: string | null;
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
  /** One chat completion, with optional tool calls and structured output. */
  chat(request: AiChatRequest): Promise<AiChatResult>;
  /** Every model this key can chat with, sorted by id. */
  listModels(): Promise<AiModel[]>;
}
