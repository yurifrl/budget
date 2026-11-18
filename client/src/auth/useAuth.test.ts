import { describe, it, expect } from 'bun:test';

import { classifyAuth, classifyProbe, shouldClearToken } from './useAuth';

describe('classifyAuth', () => {
  it('maps 200 to signed-in', () => {
    expect(classifyAuth(200)).toBe('in');
  });

  it('maps 401 to signed-out', () => {
    expect(classifyAuth(401)).toBe('out');
  });

  it('maps 403 to signed-out', () => {
    expect(classifyAuth(403)).toBe('out');
  });

  it('maps 429 and 5xx to unreachable so the session is kept and retried', () => {
    for (const status of [429, 500, 502, 503]) {
      expect(classifyAuth(status)).toBe('unreachable');
    }
  });
});

describe('shouldClearToken', () => {
  it('drops the stored token only on 401', () => {
    expect(shouldClearToken(401)).toBe(true);
    for (const status of [200, 403, 429, 500, 502, 503]) {
      expect(shouldClearToken(status)).toBe(false);
    }
  });
});

describe('classifyProbe', () => {
  it('delegates HTTP outcomes to classifyAuth', () => {
    expect(classifyProbe({ ok: true, status: 200 })).toBe('in');
    expect(classifyProbe({ ok: true, status: 401 })).toBe('out');
    expect(classifyProbe({ ok: true, status: 403 })).toBe('out');
    expect(classifyProbe({ ok: true, status: 429 })).toBe('unreachable');
    expect(classifyProbe({ ok: true, status: 500 })).toBe('unreachable');
    expect(classifyProbe({ ok: true, status: 502 })).toBe('unreachable');
    expect(classifyProbe({ ok: true, status: 503 })).toBe('unreachable');
  });

  it('maps a missing HTTP response to unreachable, not signed-out', () => {
    expect(classifyProbe({ ok: false })).toBe('unreachable');
  });
});
