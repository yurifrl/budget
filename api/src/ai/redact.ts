/**
 * Remove an API key and key-shaped strings from text that may reach a log or
 * a workflow history. Exported on the AI barrel so the categorizer and its
 * activity can redact provider text before they record it.
 */

/**
 * `sk-...` echoes. The leading `\b` keeps ordinary hyphenated words such as
 * "desk-lamp" (the `sk-` is preceded by a word character) out of the match.
 */
const SK_SHAPED_KEY = /\bsk-[A-Za-z0-9_*-]{4,}/g;
/**
 * Z.ai-shaped `<32 hex id>.<secret>`. The 32-hex id and 16+ char secret keep a
 * Unix timestamp followed by a word ("1732460000.abcdefghij") from matching.
 */
const DOTTED_KEY = /\b[0-9a-f]{32}\.[A-Za-z0-9_-]{16,}\b/gi;

/**
 * The whole key (any length) and every contiguous fragment of its first 128
 * characters (8+ chars), longest first. The whole value is included because a
 * fragment that straddles the cap would otherwise leave the tail behind.
 */
function keyFragments(apiKey: string): string[] {
  const key = apiKey.trim();
  if (!key) return [];
  const parts = new Set<string>();
  parts.add(key);
  const bounded = key.length > 128 ? key.slice(0, 128) : key;
  for (let length = bounded.length; length >= 8; length--) {
    for (let start = 0; start + length <= bounded.length; start++) parts.add(bounded.slice(start, start + length));
  }
  // Components of a dotted/segmented key (Z.ai id.secret, sk-ant-... parts).
  for (const part of key.split(/[.:_\-/]/)) if (part.length >= 8) parts.add(part);
  return [...parts].sort((a, b) => b.length - a.length);
}

/**
 * Remove the key, its fragments and every documented key shape from text.
 * Shapes run first so an `sk-` prefix is still intact for SK_SHAPED_KEY; a
 * fragment replacement would otherwise eat the prefix and let the tail pass.
 */
export function redactSecrets(detail: string, apiKey: string): string {
  let out = detail.replaceAll(SK_SHAPED_KEY, '[redacted]').replaceAll(DOTTED_KEY, '[redacted]');
  for (const fragment of keyFragments(apiKey)) out = out.replaceAll(fragment, '[redacted]');
  return out;
}
