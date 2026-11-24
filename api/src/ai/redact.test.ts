/**
 * The redaction helper is exported for the categorizer and its activity, which
 * record provider text in workflow history. It must remove key shapes without
 * mangling ordinary words.
 */
import { describe, expect, test } from 'bun:test';

import { redactSecrets } from './index';

const KEY = 'sk-or-v1-routetest0123456789abcdef';
const ZAI_KEY = '0123456789abcdef0123456789abcdef.SECRETsecret1234';

describe('redactSecrets', () => {
  test('removes the key, its fragments and key-shaped echoes', () => {
    const fragment = KEY.slice(4, 16);
    const text = `refused ${KEY} fragment ${fragment} masked sk-proj-****abcd zai ${ZAI_KEY}`;
    const redacted = redactSecrets(text, KEY);
    expect(redacted).not.toContain(KEY);
    expect(redacted).not.toContain(fragment);
    expect(redacted).not.toContain('****abcd');
    expect(redacted).not.toContain(ZAI_KEY);
    expect(redacted).toContain('[redacted]');
  });

  test('does not redact ordinary words or a timestamp', () => {
    const text = 'desk-lamp task-force 1732460000.abcdefghij';
    expect(redactSecrets(text, KEY)).toBe(text);
  });
});
