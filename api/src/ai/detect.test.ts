import { describe, expect, test } from 'bun:test';

import { detectProvider } from './detect';

describe('provider detection from the key shape', () => {
  test('each provider’s documented shape is recognized', () => {
    expect(detectProvider('sk-or-v1-0123456789abcdef0123456789abcdef')).toBe('openrouter');
    expect(detectProvider('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('anthropic');
    expect(detectProvider('sk-proj-abcdefghijklmnopqrstuvwxyz')).toBe('openai');
    expect(detectProvider('sk-svcacct-abcdefghijklmnopqrstuvwxyz')).toBe('openai');
    expect(detectProvider('sk-0123456789abcdef0123456789abcdef')).toBe('deepseek');
  });

  test('Z.ai keys are not guessed: its docs state no shape, so the caller picks it', () => {
    // Public reports disagree on the id (digits vs 32 hex), so no rule.
    expect(detectProvider('0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp')).toBeNull();
    expect(detectProvider('1234567890.abcdefghijklmnop')).toBeNull();
  });

  test('legacy sk- keys are OpenAI; anything else is unknown', () => {
    expect(detectProvider('sk-abcdefghijklmnopqrstuvwxyz012345')).toBe('openai');
    expect(detectProvider('pk-live-abcdefghijklmnopqrstuvwxyz')).toBeNull();
    expect(detectProvider('hello world')).toBeNull();
    expect(detectProvider('')).toBeNull();
  });

  test('surrounding whitespace does not change the guess', () => {
    expect(detectProvider('  sk-or-v1-0123456789abcdef0123456789abcdef  ')).toBe('openrouter');
  });
});
