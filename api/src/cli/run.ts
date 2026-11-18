/**
 * CLI runner: argv in, exit code out. Everything environmental (API URL
 * default, config dir, fetch, stdout/stderr, browser) is injected — the
 * entrypoint is the only place that reads process state.
 */
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { ApiError, createApiClient } from '../core/client';
import { inputLocations, type OperationContract } from '@shared/operation-contract';
import { AuthError, getAccessToken, login, logout, type FetchLike } from './auth';
import { openBrowser as defaultOpenBrowser } from './browser';
import {
  buildTree,
  commandWords,
  deriveFlags,
  groupHelp,
  leafHelp,
  PROG,
  rootHelp,
  type CommandNode,
} from './commands';
import { normalizeApiUrl } from './credentials';
import { coerceFlag, inputJsonSchema, UsageError, type FlagSpec } from './flags';
import { humanize, table } from './output';

export interface CliDeps {
  /** Operation contracts to generate commands from (the catalog's `.contract`s). */
  contracts: readonly OperationContract[];
  argv: string[];
  /** Resolved by the entrypoint: BUDGET_API_URL, else API_URL, else localhost. */
  defaultApiUrl: string;
  configDir: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: FetchLike;
  openBrowser?: (url: string) => void;
  now?: () => number;
  loginTimeoutMs?: number;
}

const BUILTINS = new Set(['login', 'logout', 'whoami', 'schema', 'help']);
const RESERVED_FLAGS = new Set(['json', 'api-url', 'input', 'help', 'dry-run', 'yes', 'no-browser']);

/** Dry-run sentinel: carries the request the client built. */
class DryRun extends Error {
  constructor(public readonly req: Request) {
    super('dry-run');
  }
}

/** Leading command words: stop at the first flag; skip global flags before the command. */
function splitWords(argv: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('-')) {
      words.push(a);
      continue;
    }
    if (words.length === 0 && a === '--json') continue;
    if (words.length === 0 && a === '--api-url') {
      i++;
      continue;
    }
    if (words.length === 0 && a.startsWith('--api-url=')) continue;
    break;
  }
  return words;
}

function parse(argv: string[], options: NonNullable<ParseArgsConfig['options']>, skipWords: number) {
  // Drop the command words (the leading non-flag tokens) but keep every flag.
  const rest: string[] = [];
  let skipped = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('-') && skipped < skipWords && !(i > 0 && argv[i - 1] === '--api-url')) {
      skipped++;
      continue;
    }
    rest.push(a);
  }
  try {
    return parseArgs({
      args: rest,
      options,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    throw new UsageError((err as Error).message.replace(/\. To specify a positional.*$/, ''));
  }
}

const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  'api-url': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

function findNode(root: CommandNode, words: string[]): { node: CommandNode; used: number } {
  let node = root;
  let used = 0;
  for (const w of words) {
    const next = node.children.get(w);
    if (!next) break;
    node = next;
    used++;
  }
  return { node, used };
}

function flagOptions(flags: FlagSpec[]): Record<string, { type: 'boolean' | 'string' }> {
  const out: Record<string, { type: 'boolean' | 'string' }> = {};
  for (const f of flags) {
    if (RESERVED_FLAGS.has(f.flag)) continue;
    out[f.flag] = { type: f.type === 'boolean' ? 'boolean' : 'string' };
    if (f.type === 'boolean') out[`no-${f.flag}`] = { type: 'boolean' };
  }
  return out;
}

function pathCheck(contract: OperationContract, input: Record<string, unknown>): void {
  for (const key of inputLocations(contract).path) {
    const v = input[key];
    if (typeof v === 'string' && /[/?#%\\]|\.\./.test(v)) {
      throw new UsageError(`${key}: a path identifier must not contain / ? # % \\ or ..`);
    }
  }
}

function buildInput(
  contract: OperationContract,
  flags: FlagSpec[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  let input: Record<string, unknown> = {};
  if (typeof values.input === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.input);
    } catch {
      throw new UsageError('--input: not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new UsageError('--input: expected a JSON object');
    const known = new Set(flags.map((f) => f.key));
    const unknown = Object.keys(parsed).filter((k) => !known.has(k));
    if (unknown.length) throw new UsageError(`--input: unknown key(s): ${unknown.join(', ')}`);
    input = { ...(parsed as Record<string, unknown>) };
  }
  for (const f of flags) {
    if (RESERVED_FLAGS.has(f.flag)) continue;
    if (f.type === 'boolean') {
      if (values[f.flag] === true) input[f.key] = true;
      if (values[`no-${f.flag}`] === true) input[f.key] = false;
    } else if (typeof values[f.flag] === 'string') {
      input[f.key] = coerceFlag(f, values[f.flag] as string);
    }
  }
  pathCheck(contract, input);
  const check = contract.input.safeParse(input);
  if (!check.success) {
    const missing = flags.filter((f) => f.required && input[f.key] === undefined).map((f) => `--${f.flag}`);
    if (missing.length) throw new UsageError(`missing required flag(s): ${missing.join(', ')}`);
    throw new UsageError(
      `invalid input: ${check.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`,
    );
  }
  return input;
}

export async function runCli(deps: CliDeps): Promise<number> {
  const wantJson = deps.argv.includes('--json');
  const out = (s: string) => deps.stdout(s.endsWith('\n') ? s : `${s}\n`);
  const err = (s: string) => deps.stderr(s.endsWith('\n') ? s : `${s}\n`);
  const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => {
    if (wantJson) err(JSON.stringify({ error: { code, message, ...extra } }));
    else err(`error: ${message}`);
  };
  let helpHint = `${PROG} --help`;
  const print = (data: unknown, json: boolean) =>
    out(json ? JSON.stringify(data ?? { ok: true }, null, 2) : humanize(data));

  try {
    return await dispatch();
  } catch (e) {
    if (e instanceof UsageError) {
      fail('usage', e.message);
      if (!wantJson) err(`Run \`${helpHint}\` for usage.`);
      return 2;
    }
    if (e instanceof ApiError) {
      const hint = e.status === 401 ? ' (not signed in or session invalid: run `budget login`)' : '';
      fail('api_error', `${e.message}${hint}`, {
        status: e.status,
        details: e.body,
      });
      return 1;
    }
    if (e instanceof AuthError) {
      fail(e.code, e.message);
      return 1;
    }
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    fail(cause ? 'network_error' : 'error', e instanceof Error ? e.message : String(e));
    return 1;
  }

  async function dispatch(): Promise<number> {
    const root = buildTree(deps.contracts);
    const words = splitWords(deps.argv);
    if (words.length > 0) helpHint = `${PROG} ${words.join(' ')} --help`;
    const helpRequested = deps.argv.includes('--help') || deps.argv.includes('-h');

    if (words.length === 0) {
      if (helpRequested) {
        out(rootHelp(root));
        return 0;
      }
      if (deps.argv.length === 0) {
        out(rootHelp(root));
        return 2;
      }
      throw new UsageError('missing command');
    }

    const apiUrlFrom = (v: Record<string, unknown>) =>
      normalizeApiUrl(typeof v['api-url'] === 'string' ? (v['api-url'] as string) : deps.defaultApiUrl);
    const tokenDeps = (apiUrl: string) => ({
      apiUrl,
      configDir: deps.configDir,
      fetch: deps.fetch,
      now: deps.now,
    });

    // ----- built-ins ------------------------------------------------------
    const first = words[0]!;
    if (first === 'help' && words.length === 1) {
      out(rootHelp(root));
      return 0;
    }
    if (BUILTINS.has(first) && first !== 'help') {
      if (first === 'schema') return schemaCommand(words.slice(1), root);
      const v = parse(
        deps.argv,
        {
          ...GLOBAL_OPTIONS,
          ...(first === 'login' ? { 'no-browser': { type: 'boolean' } } : {}),
        },
        1,
      );
      if (words.length > 1) throw new UsageError(`unexpected argument "${words[1]}"`);
      if (v.help) {
        out(BUILTIN_HELP_TEXT[first]!);
        return 0;
      }
      const apiUrl = apiUrlFrom(v);
      const json = v.json === true;
      if (first === 'login') {
        const result = await login({
          ...tokenDeps(apiUrl),
          announce: (url) => err(`Open this URL in a browser to sign in:\n${url}\n\nWaiting for sign-in...`),
          openBrowser: v['no-browser'] === true ? undefined : (deps.openBrowser ?? defaultOpenBrowser),
          timeoutMs: deps.loginTimeoutMs,
        });
        const data = {
          logged_in: true,
          api_url: apiUrl,
          scope: result.scope,
          expires_at: new Date(result.expires_at).toISOString(),
        };
        if (json) print(data, true);
        else out(`Logged in to ${apiUrl} (scope: ${result.scope ?? 'n/a'}).`);
        return 0;
      }
      if (first === 'logout') {
        const r = await logout(tokenDeps(apiUrl));
        if (json) print({ api_url: apiUrl, ...r }, true);
        else if (!r.was_logged_in) out(`Not logged in to ${apiUrl}.`);
        else
          out(
            r.revoked
              ? `Logged out of ${apiUrl} (session revoked).`
              : `Logged out of ${apiUrl} locally (could not reach the server to revoke).`,
          );
        return 0;
      }
      // whoami
      const client = createApiClient({
        baseUrl: apiUrl,
        token: await getAccessToken(tokenDeps(apiUrl)),
        fetch: deps.fetch,
      });
      print(await client.get('/auth/me'), json);
      return 0;
    }

    // ----- generated commands --------------------------------------------
    const { node, used } = findNode(root, words);
    if (used < words.length) {
      const known = [...node.children.keys()];
      throw new UsageError(
        `unknown command "${words.slice(0, used + 1).join(' ')}"${known.length ? `; expected one of: ${known.join(', ')}` : ''}`,
      );
    }
    if (!node.contract) {
      if (helpRequested) {
        out(groupHelp(node, words));
        return 0;
      }
      out(groupHelp(node, words));
      return 2;
    }

    const contract = node.contract;
    const flags = deriveFlags(contract);
    const options = {
      ...GLOBAL_OPTIONS,
      input: { type: 'string' },
      ...(contract.kind !== 'read' ? { 'dry-run': { type: 'boolean' } } : {}),
      ...(contract.kind === 'destructive' ? { yes: { type: 'boolean' } } : {}),
      ...flagOptions(flags),
    } as NonNullable<ParseArgsConfig['options']>;
    const values = parse(deps.argv, options, words.length);
    if (values.help) {
      out(leafHelp(contract, words, flags));
      return 0;
    }
    const json = values.json === true;
    const input = buildInput(contract, flags, values);
    const apiUrl = apiUrlFrom(values);

    if (values['dry-run'] === true) {
      const client = createApiClient({
        baseUrl: apiUrl,
        fetch: async (req) => {
          throw new DryRun(req);
        },
      });
      try {
        await client.call(contract, input);
      } catch (e) {
        if (!(e instanceof DryRun)) throw e;
        const text = await e.req.text();
        const body = text ? (JSON.parse(text) as unknown) : null;
        const data = {
          dry_run: true,
          operation: contract.name,
          method: e.req.method,
          url: e.req.url,
          body,
        };
        if (json) print(data, true);
        else
          out(
            `DRY RUN (nothing sent)\n${e.req.method} ${e.req.url}${body !== null ? `\n${JSON.stringify(body, null, 2)}` : ''}`,
          );
        return 0;
      }
      throw new Error('dry-run did not capture a request');
    }
    if (contract.kind === 'destructive' && values.yes !== true) {
      throw new UsageError(`${contract.name} is destructive; re-run with --yes to confirm (or --dry-run to preview)`);
    }

    const token = await getAccessToken(tokenDeps(apiUrl));
    const client = createApiClient({
      baseUrl: apiUrl,
      token,
      fetch: deps.fetch,
    });
    print(await client.call(contract, input), json);
    return 0;
  }

  function schemaCommand(rest: string[], root: CommandNode): number {
    const v = parse(deps.argv, { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, 1 + rest.length);
    if (v.help) {
      out(BUILTIN_HELP_TEXT.schema!);
      return 0;
    }
    const cliContracts = deps.contracts.filter((c) => c.expose.cli);
    if (rest.length === 0) {
      const rows = cliContracts.map((c) => ({
        operation: c.name,
        kind: c.kind,
        command: commandWords(c).join(' '),
        description: c.description,
      }));
      if (v.json) out(JSON.stringify(rows, null, 2));
      else
        out(
          table(
            rows.map((r) => ({
              ...r,
              description: r.description.split(/(?<=\.)\s/)[0],
            })),
          ),
        );
      return 0;
    }
    const wanted = rest.length === 1 ? rest[0]! : rest.join('_');
    const contract =
      cliContracts.find((c) => c.name === wanted) ??
      cliContracts.find((c) => commandWords(c).join(' ') === rest.join(' '));
    if (!contract) {
      void root;
      throw new UsageError(`unknown operation "${rest.join(' ')}"; run \`${PROG} schema\` to list them`);
    }
    out(
      JSON.stringify(
        {
          ...inputJsonSchema(contract),
          title: contract.name,
          description: contract.description,
          'x-budget': {
            kind: contract.kind,
            method: contract.method,
            path: contract.path,
            command: commandWords(contract).join(' '),
          },
        },
        null,
        2,
      ),
    );
    return 0;
  }
}

const BUILTIN_HELP_TEXT: Record<string, string> = {
  login: `Usage: ${PROG} login [--api-url <url>] [--no-browser] [--json]\n\nSign in with the browser (authorization code + PKCE on a loopback port). The URL is always printed, so it works over SSH too.`,
  logout: `Usage: ${PROG} logout [--api-url <url>] [--json]\n\nRevoke the session on the server and delete the local credentials.`,
  whoami: `Usage: ${PROG} whoami [--api-url <url>] [--json]\n\nShow the signed-in user (GET /auth/me).`,
  schema: `Usage: ${PROG} schema [operation] [--json]\n\nWithout an argument, list every operation (name, kind, command, description). With an operation name or command words, print the JSON Schema of its input.`,
};
