/**
 * Command tree generated from operation contracts: the command path is the
 * operation name split on `_` (budget_transactions_list -> budget transactions
 * list). Nothing here knows any specific operation.
 */
import type { OperationContract } from '@shared/operation-contract';
import { flagUsage, deriveFlags, type FlagSpec } from './flags';

export interface CommandNode {
  /** Path segment ('' at the root). */
  word: string;
  children: Map<string, CommandNode>;
  contract?: OperationContract;
}

export const PROG = 'budget';

export function commandWords(contract: OperationContract): string[] {
  return contract.name.split('_').filter(Boolean);
}

export function buildTree(contracts: readonly OperationContract[]): CommandNode {
  const root: CommandNode = { word: '', children: new Map() };
  for (const contract of contracts) {
    if (!contract.expose.cli) continue;
    let node = root;
    for (const w of commandWords(contract)) {
      let next = node.children.get(w);
      if (!next) {
        next = { word: w, children: new Map() };
        node.children.set(w, next);
      }
      node = next;
    }
    node.contract = contract;
  }
  return root;
}

const plural = (n: number) => `${n} command${n === 1 ? '' : 's'}`;

function leafCount(node: CommandNode): number {
  return (node.contract ? 1 : 0) + [...node.children.values()].reduce((n, c) => n + leafCount(c), 0);
}

const firstSentence = (s: string) => (s.split(/(?<=\.)\s/)[0] ?? s).trim();

function pad(rows: [string, string][]): string[] {
  const w = Math.max(0, ...rows.map(([a]) => a.length));
  return rows.map(([a, b]) => `  ${a.padEnd(w)}  ${b}`.trimEnd());
}

export const GLOBAL_FLAG_HELP: [string, string][] = [
  ['--json', 'machine-readable JSON on stdout (errors become JSON on stderr)'],
  ['--api-url <url>', 'API base URL (default: BUDGET_API_URL, API_URL, http://localhost:3100)'],
  ['--input <json>', 'operation input as a JSON object; flags override its keys'],
  ['-h, --help', 'show help'],
];

export const BUILTIN_HELP: [string, string][] = [
  ['login', 'sign in via the browser (OAuth, PKCE) and store credentials'],
  ['logout', 'revoke the session and delete local credentials'],
  ['whoami', 'show the signed-in user (GET /auth/me)'],
  ['schema [operation]', "list operations, or print one operation's input JSON Schema"],
];

export function rootHelp(root: CommandNode): string {
  const groups = [...root.children.values()].map((n): [string, string] => [n.word, plural(leafCount(n))]);
  return [
    `${PROG} — command line for the Budget API (commands are generated from the operation catalog)`,
    '',
    `Usage: ${PROG} <command> [flags]`,
    '',
    'Account:',
    ...pad(BUILTIN_HELP),
    '',
    'Command groups:',
    ...pad(groups),
    '',
    'Global flags:',
    ...pad(GLOBAL_FLAG_HELP),
    '',
    `Run \`${PROG} <group> --help\` to list a group, \`${PROG} schema\` for every operation.`,
  ].join('\n');
}

export function groupHelp(node: CommandNode, path: string[]): string {
  const rows = [...node.children.values()].map((c): [string, string] => [
    c.word,
    c.contract && c.children.size === 0 ? firstSentence(c.contract.description) : plural(leafCount(c)),
  ]);
  return [`Usage: ${PROG} ${path.join(' ')} <command> [flags]`, '', 'Commands:', ...pad(rows)].join('\n');
}

export function leafHelp(contract: OperationContract, path: string[], flags: FlagSpec[]): string {
  const rows = flags.map((f): [string, string] => [
    flagUsage(f),
    [f.required ? '(required)' : '', f.type === 'boolean' ? `[--no-${f.flag}]` : '', f.description ?? '']
      .filter(Boolean)
      .join(' '),
  ]);
  const extra: [string, string][] = [];
  if (contract.kind !== 'read') extra.push(['--dry-run', 'print the request that would be sent; send nothing']);
  if (contract.kind === 'destructive') extra.push(['--yes', 'required to run this destructive operation']);
  const tail = [...GLOBAL_FLAG_HELP, ...extra];
  return [
    contract.description,
    '',
    `Usage: ${PROG} ${path.join(' ')} [flags]`,
    `Operation: ${contract.name}  (${contract.kind}, ${contract.method} ${contract.path})`,
    '',
    'Flags:',
    ...(rows.length ? pad(rows) : ['  (none)']),
    '',
    'Common flags:',
    ...pad(tail),
    '',
    `Input schema: ${PROG} schema ${contract.name}`,
    'Tip: pass negative numbers as --flag=-5 (a bare -5 reads as a flag).',
  ].join('\n');
}

export { deriveFlags };
