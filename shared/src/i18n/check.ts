/**
 * Catalog checker used by the i18n tests of every package (shared, client,
 * admin). Pure: the test reads the package's source files and passes the text.
 *
 * Checks, per registered namespace:
 *  - pt-BR has exactly the keys of en, with the same plural shape;
 *  - en and pt-BR use the same `{placeholder}` set for every key;
 *  - no empty value;
 *  - pt-BR equals en only for keys in the namespace's `sameAsEnglish` list
 *    (and a listed key must really be identical);
 *  - key names are flat dotted camelCase, at most three segments;
 *  - every key appears as a string literal in `sources` (unused keys), unless
 *    the namespace is exempt or the key starts with a `dynamicPrefixes` entry.
 */

import type { Catalog, Message, RegisteredNamespace } from './types';

const PLACEHOLDER = /\{([A-Za-z_]\w*)\}/g;
const KEY_FORMAT = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+){0,2}$/;

function placeholders(message: Message): string[] {
  const texts = typeof message === 'string' ? [message] : [message.one, message.other];
  const found = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(PLACEHOLDER)) found.add(m[1] as string);
  return [...found].sort();
}

function texts(message: Message): string[] {
  return typeof message === 'string' ? [message] : [message.one, message.other];
}

function isPlural(message: Message | undefined): boolean {
  return typeof message === 'object' && message !== null;
}

function sameMessage(a: Message, b: Message): boolean {
  const ta = texts(a);
  const tb = texts(b);
  return ta.length === tb.length && ta.every((text, i) => text === tb[i]);
}

function literalAppears(sources: string, key: string): boolean {
  return sources.includes(`'${key}'`) || sources.includes(`"${key}"`) || sources.includes(`\`${key}\``);
}

/**
 * @param sources concatenated text of the package's source files outside any
 *   `i18n/` directory (and outside the catalog test itself); `undefined` skips
 *   the unused-key check.
 * @returns one human-readable line per problem; empty when every catalog is sound.
 */
export function checkCatalogs(namespaces: readonly RegisteredNamespace[], sources?: string): string[] {
  const problems: string[] = [];
  for (const ns of namespaces) {
    const at = (key: string) => `[${ns.name}] ${key}`;
    const en = ns.en;
    const pt: Catalog = ns.catalogs['pt-BR'];

    for (const key of Object.keys(pt)) {
      if (!(key in en)) problems.push(`${at(key)}: in pt-BR but not in en`);
    }
    for (const [key, enMsg] of Object.entries(en)) {
      if (ns.name !== 'errors' && !KEY_FORMAT.test(key)) {
        problems.push(`${at(key)}: key must be flat dotted camelCase, at most three segments`);
      }
      const ptMsg = pt[key];
      if (ptMsg === undefined) {
        problems.push(`${at(key)}: missing in pt-BR`);
        continue;
      }
      if (isPlural(enMsg) !== isPlural(ptMsg)) {
        problems.push(`${at(key)}: plural shape differs between en and pt-BR`);
        continue;
      }
      if (isPlural(enMsg)) {
        for (const [loc, msg] of [['en', enMsg], ['pt-BR', ptMsg]] as const) {
          const names = Object.keys(msg as object).sort().join(',');
          if (names !== 'one,other') problems.push(`${at(key)}: ${loc} plural must be exactly { one, other }`);
        }
      }
      for (const [loc, msg] of [['en', enMsg], ['pt-BR', ptMsg]] as const) {
        if (texts(msg).some((text) => typeof text !== 'string' || text.trim() === '')) {
          problems.push(`${at(key)}: empty ${loc} value`);
        }
      }
      const enNames = placeholders(enMsg).join(',');
      const ptNames = placeholders(ptMsg).join(',');
      if (enNames !== ptNames) {
        problems.push(`${at(key)}: placeholders differ (en {${enNames}} vs pt-BR {${ptNames}})`);
      }
      const same = sameMessage(enMsg, ptMsg);
      if (same && !ns.sameAsEnglish.has(key)) {
        problems.push(`${at(key)}: pt-BR is identical to en (translate it, or list the key in sameAsEnglish)`);
      }
      if (!same && ns.sameAsEnglish.has(key)) {
        problems.push(`${at(key)}: listed in sameAsEnglish but pt-BR differs (remove it from the list)`);
      }
      if (
        sources !== undefined &&
        !ns.skipUnusedCheck &&
        !ns.dynamicPrefixes.some((prefix) => key.startsWith(prefix)) &&
        !literalAppears(sources, key)
      ) {
        problems.push(`${at(key)}: unused (no string literal "${key}" in the package source)`);
      }
    }
    for (const key of ns.sameAsEnglish) {
      if (!(key in en)) problems.push(`${at(key)}: listed in sameAsEnglish but not a key`);
    }
  }
  return problems;
}
