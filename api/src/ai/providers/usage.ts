/**
 * Token usage from provider chat payloads. Providers report the same two
 * numbers under vendor-specific names (OpenAI-compatible prompt_tokens /
 * completion_tokens; Anthropic input_tokens / output_tokens); this maps them
 * onto the port's one shape and answers null when either side is missing, so
 * callers never report a made-up number.
 */
import type { AiTokenUsage } from '../types';

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;

export function tokenUsage(input: unknown, output: unknown): AiTokenUsage | null {
  const inputTokens = count(input);
  const outputTokens = count(output);
  return inputTokens === null || outputTokens === null ? null : { input: inputTokens, output: outputTokens };
}
