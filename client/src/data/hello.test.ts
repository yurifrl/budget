import { describe, expect, test } from 'bun:test';

import { fetchHello, helloUrl } from './hello';

describe('hello client', () => {
  test('builds the URL from the shared contract', () => {
    expect(helloUrl('http://api.test', { name: 'Ada' })).toBe('http://api.test/hello?name=Ada');
    expect(helloUrl('http://api.test')).toBe('http://api.test/hello');
  });

  test('fetches and validates the response with the shared schema', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ message: 'Hello, Ada!' }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchHello({ name: 'Ada' }, { base: 'http://api.test', fetchImpl })).toEqual({ message: 'Hello, Ada!' });
    expect(calls).toEqual(['http://api.test/hello?name=Ada']);
  });

  test('rejects a malformed response', async () => {
    const fetchImpl = (async () => new Response('{"msg":1}', { status: 200 })) as unknown as typeof fetch;
    expect(fetchHello({}, { base: 'http://api.test', fetchImpl })).rejects.toThrow();
  });
});
