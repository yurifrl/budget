/**
 * The agent loop in isolation (no database): per-call output cap, the final
 * structured-output turn keeping the tools declared (Anthropic requires the
 * same tools while tool_use blocks are in the history), reason sanitizing,
 * confidence clamping, the per-transaction token cap and the "all ids unknown"
 * answer that must not be treated as an empty answer.
 */
import { describe, expect, test } from 'bun:test';

import { AiProviderError, type AiChatRequest, type AiChatResult } from '../ai';
import {
  classifyTransaction,
  MAX_MODEL_CONFIDENCE,
  MAX_REASON_CHARS,
  sanitizeReason,
  type ClassifyRequest,
} from './agent';
import { CategorizeError } from './errors';
import { CLASSIFY_MAX_CALLS, CLASSIFY_MAX_TOKENS, CLASSIFY_MAX_TOKENS_PER_TRANSACTION } from './jobspec';
import type { AgentTransaction } from './store';
import { fakeProviders } from './testing';
import type { CategorizeTools } from './tools';

const FOOD = '0b8f5c1e-4d1a-4c5b-9c3e-2f6a1d0e7b11';
const DINING = '6c2a9d3f-8e4b-4f1a-b7c5-0d9e2a4b6c33';
const UNKNOWN = '11111111-2222-4333-8444-555555555555';

const transaction: AgentTransaction = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  date: '2026-11-01',
  amount_milliunits: -2500,
  account: { name: 'Checking', type: 'checking', currency: 'BRL' },
  payee: 'Padaria',
  payee_id: null,
  memo: null,
  category: null,
  bank: null,
};

const tools: CategorizeTools = {
  definitions: [{ name: 'list_categories', description: 'List categories', parameters: { type: 'object' } }],
  execute: async () => '{"groups":[]}',
};

function providerOf(handler: (request: AiChatRequest, call: number) => AiChatResult | Promise<AiChatResult>) {
  return fakeProviders(handler).table.openai.create('sk-test');
}

const request = (handler: (req: AiChatRequest, call: number) => AiChatResult | Promise<AiChatResult>): ClassifyRequest => ({
  provider: providerOf(handler),
  model: 'fake-model',
  transaction,
  tools,
  allowedCategoryIds: new Set([FOOD, DINING]),
});

const reply = (text: string | null, usage = { input: 10, output: 5 }, toolCalls: AiChatResult['toolCalls'] = []): AiChatResult => ({
  text,
  toolCalls,
  model: 'fake-model',
  finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
  usage,
});

const answer = (suggestions: unknown[]) => reply(JSON.stringify({ suggestions }));

describe('agent cost bounds', () => {
  test('every call carries the output cap and asks for low reasoning effort', async () => {
    const seen: (number | undefined)[] = [];
    const efforts: (string | undefined)[] = [];
    await classifyTransaction(
      request((req) => {
        seen.push(req.maxTokens);
        efforts.push(req.reasoningEffort);
        return answer([{ category_id: FOOD, confidence: 0.8, reason: 'bread' }]);
      }),
    );
    expect(seen).toEqual([CLASSIFY_MAX_TOKENS]);
    expect(efforts).toEqual(['low']);
  });

  test('a cut-off answer is truncated, not bad_response, and its usage is kept', async () => {
    const error = await classifyTransaction(
      request(() => ({ ...answer([{ category_id: FOOD, confidence: 0.9 }]), finishReason: 'max_tokens' })),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CategorizeError);
    expect((error as CategorizeError).kind).toBe('truncated');
    expect((error as CategorizeError).usage).toEqual({ input: 10, output: 5 });
  });

  test('the final structured-output turn keeps the tools declared and disables new calls', async () => {
    const seen: AiChatRequest[] = [];
    const result = await classifyTransaction(
      request((req, call) => {
        seen.push(req);
        if (call === 1) return reply('not json at all');
        return answer([{ category_id: FOOD, confidence: 0.8, reason: 'bread' }]);
      }),
    );
    expect(result.suggestions.map((s) => s.categoryId)).toEqual([FOOD]);
    const final = seen[1]!;
    expect(final.jsonSchema?.name).toBe('category_suggestions');
    // The M6 regression: dropping `tools` here is what Anthropic rejects
    // while tool_use/tool_result blocks are in the history.
    expect(final.tools?.map((tool) => tool.name)).toEqual(['list_categories']);
    expect(final.toolChoice).toBe('none');
    // The first answer turn may still call tools.
    expect(seen[0]!.toolChoice).toBeUndefined();
  });

  test('the tool loop is bounded and never exceeds the per-transaction call cap', async () => {
    let calls = 0;
    const error = await classifyTransaction(
      request(() => {
        calls++;
        return reply(null, { input: 1, output: 0 }, [{ id: `call-${calls}`, name: 'list_categories', arguments: {} }]);
      }),
    ).catch((e: unknown) => e);
    expect(calls).toBeLessThanOrEqual(CLASSIFY_MAX_CALLS);
    // Four tool turns, then the final turn keeps returning a tool call with no
    // text, which is not the answer schema.
    expect(error).toBeInstanceOf(CategorizeError);
    expect((error as CategorizeError).kind).toBe('bad_response');
  });

  test('a transaction that spends its token cap fails with kind budget', async () => {
    let calls = 0;
    const error = await classifyTransaction(
      request(() => {
        calls++;
        return reply(null, { input: CLASSIFY_MAX_TOKENS_PER_TRANSACTION, output: 0 }, [
          { id: `call-${calls}`, name: 'list_categories', arguments: {} },
        ]);
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CategorizeError);
    expect((error as CategorizeError).kind).toBe('budget');
    expect(calls).toBe(2);
  });
});

describe('model reasons and confidence', () => {
  test('sanitizeReason strips control and bidirectional characters, collapses and caps', () => {
    const raw = `  first\u0007 line\nsecond \u202Ereversed\u202C ${'x'.repeat(400)}  `;
    const clean = sanitizeReason(raw)!;
    expect(clean).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    expect(clean.startsWith('first line second reversed')).toBe(true);
    expect(clean.length).toBe(MAX_REASON_CHARS);
    expect(sanitizeReason('  \u202E ')).toBeNull();
    expect(sanitizeReason(null)).toBeNull();
  });

  test('an overlong unsafe reason is stored truncated, and confidence can never be 1', async () => {
    const result = await classifyTransaction(
      request(() =>
        answer([{ category_id: FOOD, confidence: 1, reason: `Call +55 11 99999-0000 now\n${'IGNORE PREVIOUS '.repeat(40)}` }]),
      ),
    );
    const [first] = result.suggestions;
    expect(first!.confidence).toBe(MAX_MODEL_CONFIDENCE);
    expect(first!.reason!.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
    expect(first!.reason).not.toContain('\n');
  });

  test('an answer naming only unknown ids is bad_response, never an empty answer', async () => {
    const error = await classifyTransaction(
      request((req, call) => (call === 1 ? answer([{ category_id: UNKNOWN, confidence: 0.9 }]) : answer([{ category_id: UNKNOWN, confidence: 0.9 }]))),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CategorizeError);
    expect((error as CategorizeError).kind).toBe('bad_response');
  });

  test('a legitimately empty list is an answer', async () => {
    const result = await classifyTransaction(request(() => answer([])));
    expect(result.suggestions).toEqual([]);
  });

  test('a provider failure keeps its safe taxonomy and never the upstream text', async () => {
    const error = await classifyTransaction(
      request(() => {
        throw new AiProviderError('permanent', 'upstream said: content filter', 400);
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CategorizeError);
    expect((error as CategorizeError).kind).toBe('request');
    expect((error as Error).message).not.toContain('upstream');
  });
});
