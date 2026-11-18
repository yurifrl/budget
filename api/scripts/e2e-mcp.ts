/**
 * MCP end-to-end driver against a server with auth ON (see e2e-consent.ts).
 *
 *   bun scripts/e2e-mcp.ts stdio   # src/mcp.ts as the CLI-logged-in user
 *   bun scripts/e2e-mcp.ts http    # POST /mcp with a token from a fresh DCR + PKCE flow
 *
 * Env: BUDGET_API_URL, SESSION_SECRET, E2E_EMAIL, XDG_CONFIG_HOME (stdio reads
 * the credentials `bun src/cli.ts login` stored), E2E_BUDGET_ID,
 * E2E_ACCOUNT_ID. Tokens are never printed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { approve } from './e2e-consent';

const api = (process.env.BUDGET_API_URL ?? 'http://localhost:3100').replace(/\/+$/, '');
const budget_id = process.env.E2E_BUDGET_ID ?? '';
const account_id = process.env.E2E_ACCOUNT_ID ?? '';
const say = (s: string) => console.log(s);

const redact = (s: string) => s.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>').replace(/(code|refresh_token)=[^&\s"]+/g, '$1=<redacted>');

async function exercise(client: Client, label: string): Promise<void> {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  say(`[${label}] tools/list -> ${names.length} tools; write tools: ${names.includes('budget_transaction_add')}; destructive present: ${names.includes('budget_delete')}`);
  say(`[${label}] sample: ${names.slice(0, 5).join(', ')}`);
  const read = await client.callTool({ name: 'budget_list', arguments: {} });
  say(`[${label}] call budget_list -> isError=${read.isError ?? false} ${redact(JSON.stringify(read.content)).slice(0, 160)}`);
  if (!names.includes('budget_transaction_add')) {
    say(`[${label}] (read-only grant: no write tool listed)`);
    return;
  }
  const write = await client.callTool({
    name: 'budget_transaction_add',
    arguments: { budget_id, account_id, amount_cents: -250, payee: `E2E MCP ${label}`, memo: `hobj e2e ${label}` },
  });
  say(`[${label}] call budget_transaction_add -> isError=${write.isError ?? false} ${redact(JSON.stringify(write.content)).slice(0, 160)}`);
}

async function stdio(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['src/mcp.ts'],
    env: { ...(process.env as Record<string, string>) },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e-stdio', version: '1.0.0' });
  await client.connect(transport);
  say(`[stdio] connected to src/mcp.ts (api ${api})`);
  await exercise(client, 'stdio');
  await client.close();
}

/** Dynamic registration + authorization code + PKCE; returns an access token. */
async function oauthToken(scope: string): Promise<string> {
  const code = await new Promise<{ redirect: string; wait: Promise<URL> }>((resolve) => {
    let got: (u: URL) => void;
    const wait = new Promise<URL>((r) => (got = r));
    const srv = createServer((req, res) => {
      res.end('ok');
      got(new URL(req.url ?? '/', 'http://127.0.0.1'));
      srv.close();
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ redirect: `http://127.0.0.1:${port}/callback`, wait });
    });
  });
  const reg = await fetch(`${api}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'e2e DCR client', redirect_uris: [code.redirect] }),
  });
  const client = (await reg.json()) as { client_id: string };
  say(`[http] POST /oauth/register -> ${reg.status} client_id=${client.client_id.slice(0, 8)}…`);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authUrl = `${api}/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: code.redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope,
    state: 'e2e-state',
    resource: `${api}/mcp`,
  })}`;
  await approve(authUrl, (s) => say(`[http] ${redact(s)}`));
  const cb = await code.wait;
  const tok = await fetch(`${api}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: cb.searchParams.get('code') ?? '',
      redirect_uri: code.redirect,
      code_verifier: verifier,
    }),
  });
  const body = (await tok.json()) as { access_token: string; scope: string; expires_in: number };
  say(`[http] POST /oauth/token -> ${tok.status} scope="${body.scope}" expires_in=${body.expires_in} access_token=<redacted> refresh_token=<redacted>`);
  return body.access_token;
}

async function http(): Promise<void> {
  const challenge = await fetch(`${api}/mcp`, { method: 'POST' });
  say(`[http] POST /mcp without token -> ${challenge.status} WWW-Authenticate: ${challenge.headers.get('www-authenticate')}`);
  const meta = await fetch(`${api}/.well-known/oauth-protected-resource`);
  say(`[http] GET /.well-known/oauth-protected-resource -> ${meta.status} ${JSON.stringify(await meta.json())}`);

  for (const scope of ['read write', 'read']) {
    const token = await oauthToken(scope);
    const client = new Client({ name: `e2e-http-${scope}`, version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${api}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    await exercise(client, `http:${scope.replace(' ', '+')}`);
    await client.close();
    if (scope === 'read write') {
      const bad = await fetch(`${api}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer not-a-token' } });
      say(`[http] POST /mcp with bad token -> ${bad.status}`);
    }
  }
}

const mode = process.argv[2];
if (mode === 'stdio') await stdio();
else if (mode === 'http') await http();
else {
  console.error('usage: bun scripts/e2e-mcp.ts stdio|http');
  process.exit(2);
}
process.exit(0);
