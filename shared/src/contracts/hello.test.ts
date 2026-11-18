import { describe, expect, test } from 'bun:test';

import { inputLocations } from '../operation-contract';
import { helloGet, helloOutput } from './hello';

describe('hello_get contract', () => {
  test('is a GET on /hello with name in the query', () => {
    expect(helloGet.name).toBe('hello_get');
    expect(helloGet.method).toBe('GET');
    expect(helloGet.path).toBe('/hello');
    expect(inputLocations(helloGet)).toEqual({ path: [], query: ['name'], body: [] });
  });

  test('validates input and output', () => {
    expect(helloGet.input.parse({ name: 'Ada' })).toEqual({ name: 'Ada' });
    expect(() => helloGet.input.parse({ name: '' })).toThrow();
    expect(helloOutput.parse({ message: 'hi' })).toEqual({ message: 'hi' });
  });
});
