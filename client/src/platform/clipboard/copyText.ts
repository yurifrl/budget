/**
 * Put text on the clipboard (web: the async Clipboard API). Resolves true
 * when it was copied, so the caller can confirm with a "Copied" mark.
 * Native counterpart: `copyText.native.ts` (no clipboard module in the app:
 * the share sheet, which offers Copy).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
