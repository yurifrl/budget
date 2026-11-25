/**
 * Fake AI provider for tests: every provider id resolves to one adapter that
 * records the request and the key it was built with, then delegates to the
 * test's handler. No HTTP, no real key.
 *
 * Tests install it with `setProviders` from `../../ai/providers` (a deliberate
 * deep import: the swap hands out the decrypted key, so it is not on the AI
 * barrel).
 */
import { AI_PROVIDERS, type AiProviderId } from '@shared/contracts/ai';

import type { AiChatRequest, AiChatResult } from '../../ai';
import type { ProviderEntry } from '../../ai/providers';

export type FakeCall = { request: AiChatRequest; apiKey: string };

export type FakeProviders = {
  /** Pass to setProviders(). */
  table: Record<AiProviderId, ProviderEntry>;
  calls: FakeCall[];
};

export type FakeHandler = (request: AiChatRequest, callNumber: number) => AiChatResult | Promise<AiChatResult>;

export function fakeProviders(handler: FakeHandler): FakeProviders {
  const calls: FakeCall[] = [];
  const entry = (id: AiProviderId): ProviderEntry => ({
    baseUrl: `https://${id}.test`,
    create: (apiKey: string) => ({
      id,
      async chat(request: AiChatRequest): Promise<AiChatResult> {
        calls.push({ request, apiKey });
        return handler(request, calls.length);
      },
      async verifyKey(): Promise<null> {
        return null;
      },
      async listModels() {
        return [];
      },
    }),
  });
  const table = Object.fromEntries(AI_PROVIDERS.map((id) => [id, entry(id)])) as Record<AiProviderId, ProviderEntry>;
  return { table, calls };
}

/** One valid final answer (no tool calls), with provider-reported usage. */
export function answer(
  suggestions: { category_id: string; confidence: number; reason?: string }[],
  usage: { input: number; output: number } = { input: 10, output: 5 },
): AiChatResult {
  return {
    text: JSON.stringify({ suggestions: suggestions.map((s) => ({ reason: 'evidence', ...s })) }),
    toolCalls: [],
    model: 'fake-model',
    finishReason: 'stop',
    usage,
  };
}

/** One answer that asks for a tool. */
export function toolTurn(name: string, args: Record<string, unknown>, text: string | null = null): AiChatResult {
  return {
    text,
    toolCalls: [{ id: `call-${Math.random().toString(36).slice(2)}`, name, arguments: args }],
    model: 'fake-model',
    finishReason: 'tool_use',
    usage: { input: 7, output: 3 },
  };
}
