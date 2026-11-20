import { describe, expect, test } from 'bun:test';

import { inputLocations } from '../../operation-contract';
import {
  connectionCredentialsSchema,
  connectionSchema,
  connectionStatusSchema,
  connectionsCredentialsDelete,
  connectionsCredentialsGet,
  connectionsCredentialsSave,
  contracts,
  syncStateSchema,
} from './index';

describe('own key set contracts', () => {
  test('three operations on /connections/credentials, in the connections barrel; none reaches MCP and save is api only', () => {
    const names = contracts.map((c) => c.name);
    for (const c of [connectionsCredentialsGet, connectionsCredentialsSave, connectionsCredentialsDelete]) {
      expect(names).toContain(c.name);
      expect(c.path).toBe('/connections/credentials');
      expect(c.expose.mcp).toBe(false);
    }
    expect([connectionsCredentialsGet.method, connectionsCredentialsSave.method, connectionsCredentialsDelete.method]).toEqual(['GET', 'PUT', 'DELETE']);
    expect(connectionsCredentialsSave.expose).toEqual({ api: true, cli: false, mcp: false });
  });

  test('user-scoped: no path id and no budget_id; the provider defaults to pluggy', () => {
    expect(inputLocations(connectionsCredentialsGet)).toEqual({ path: [], query: ['provider'], body: [] });
    expect(inputLocations(connectionsCredentialsSave)).toEqual({ path: [], query: [], body: ['provider', 'clientId', 'clientSecret'] });
    expect(inputLocations(connectionsCredentialsDelete)).toEqual({ path: [], query: ['provider'], body: [] });
    expect(connectionsCredentialsGet.input.parse({})).toEqual({ provider: 'pluggy' });
    expect(connectionsCredentialsSave.input.parse({ clientId: ' id ', clientSecret: ' s ' })).toEqual({ provider: 'pluggy', clientId: 'id', clientSecret: 's' });
  });

  test('save needs both halves of the pair', () => {
    expect(connectionsCredentialsSave.input.safeParse({ clientId: 'id' }).success).toBe(false);
    expect(connectionsCredentialsSave.input.safeParse({ clientId: '  ', clientSecret: 's' }).success).toBe(false);
    expect(connectionsCredentialsSave.input.safeParse({ clientId: 'id', clientSecret: '' }).success).toBe(false);
  });

  test('the status output has no field for the secret', () => {
    expect(Object.keys(connectionCredentialsSchema.shape).sort()).toEqual(['clientId', 'hasSecret', 'provider', 'updatedAt']);
    expect(connectionsCredentialsGet.output).toBe(connectionCredentialsSchema);
    expect(connectionsCredentialsSave.output).toBe(connectionCredentialsSchema);
    const none = { provider: 'pluggy', clientId: null, hasSecret: false, updatedAt: null };
    expect(connectionCredentialsSchema.parse(none)).toEqual(none);
  });

  test("a connection carries its key set, and 'paused' is a status and a sync state", () => {
    expect(connectionStatusSchema.options).toContain('paused');
    expect(syncStateSchema.options).toContain('paused');
    expect(connectionSchema.shape.key_source.options).toEqual(['shared', 'own']);
  });
});
