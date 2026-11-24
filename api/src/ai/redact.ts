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
 * The key and every contiguous fragment of it (8+ chars, capped at 128) as
 * replacement targets, longest first. A provider that echoes a truncated or
 * reformatted key still gets the echoed part removed; keys longer than the cap
 * are covered by the exact whole-value replacement.
 */
function keyFragments(apiKey: string): string[] {
  const key = apiKey.trim();
  const parts = new Set<string>();
  const bounded = key.length > 128 ? key.slice(0, 128) : key;
  for (let length = bounded.length; length >= 8; length--) {
    for (let start = 0; start + length <= bounded.length; start++) parts.add(bounded.slice(start, start + length));
  }
  // Components of a dotted/segmented key (Z.ai id.secret, sk-ant-... parts).
  for (const part of key.split(/[.:_\-/]/)) if (part.length >= 8) parts.add(part);
  return [...parts].sort((a, b) => b.length - a.length);
}

/** Remove the key, its fragments and every documented key shape from text. */
export function redactSecrets(detail: string, apiKey: string): string {
  let out = detail;
  for (const fragment of keyFragments(apiKey)) out = out.replaceAll(fragment, '[redacted]');
  return out.replaceAll(SK_SHAPED_KEY, '[redacted]').replaceAll(DOTTED_KEY, '[redacted]');
}
