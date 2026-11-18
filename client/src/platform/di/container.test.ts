import { describe, expect, it } from 'bun:test';

import { Container, token } from './container';

describe('Container', () => {
  it('registers and resolves a service by token', () => {
    const c = new Container();
    const Greeter = token<{ hi: () => string }>('Greeter');
    c.register(Greeter, () => ({ hi: () => 'hello' }));
    expect(c.resolve(Greeter).hi()).toBe('hello');
  });

  it('caches the instance (singleton per container)', () => {
    const c = new Container();
    const Counter = token<{ n: number }>('Counter');
    let calls = 0;
    c.register(Counter, () => {
      calls += 1;
      return { n: calls };
    });
    expect(c.resolve(Counter)).toBe(c.resolve(Counter));
    expect(calls).toBe(1);
  });

  it('throws a clear error for an unregistered token', () => {
    const c = new Container();
    const Missing = token<string>('Missing');
    expect(() => c.resolve(Missing)).toThrow(/No service registered for token "Missing"/);
  });

  it('supports registerValue and has()', () => {
    const c = new Container();
    const Conf = token<{ env: string }>('Conf');
    expect(c.has(Conf)).toBe(false);
    c.registerValue(Conf, { env: 'test' });
    expect(c.has(Conf)).toBe(true);
    expect(c.resolve(Conf).env).toBe('test');
  });
});
