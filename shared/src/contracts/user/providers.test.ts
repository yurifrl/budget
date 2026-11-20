import { describe, expect, test } from 'bun:test';

import { inputLocations } from '../../operation-contract';
import { contracts } from './index';
import { authProviders, authProvidersSchema } from './providers';

describe('user_auth_providers contract', () => {
  test('is an api-only GET on /auth/providers with no input', () => {
    expect(authProviders.output).toBe(authProvidersSchema);
    expect(authProviders.method).toBe('GET');
    expect(authProviders.path).toBe('/auth/providers');
    expect(authProviders.expose).toEqual({ api: true, cli: false, mcp: false });
    expect(inputLocations(authProviders)).toEqual({ path: [], query: [], body: [] });
    expect(contracts.map((c) => c.name)).toContain('user_auth_providers');
  });

  test('output is three booleans, nothing else', () => {
    expect(authProvidersSchema.parse({ access: true, google: false, password: true })).toEqual({ access: true, google: false, password: true });
    expect(() => authProvidersSchema.parse({ access: 'yes', google: false, password: true })).toThrow();
    expect(() => authProvidersSchema.parse({ access: true, google: false })).toThrow();
  });
});
