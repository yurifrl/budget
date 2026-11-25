/**
 * Pure logic of sending the rows held by the leave prompt: one request per
 * row, in order, and what became of each. A row the server refuses for good
 * (categorized elsewhere, not allowed, gone) is dropped with a note; a row that
 * failed for a reason that may pass (network, 5xx) stays for another try.
 */

import type { SkipEntry } from './accept.logic';
import { skipFailureKind } from './page.logic';

export interface SendOutcome {
  sent: SkipEntry[];
  /** Refused for good: they leave the list of waiting rows, with a note. */
  dropped: SkipEntry[];
  /** May pass: they stay. */
  retry: SkipEntry[];
}

export async function sendEntries(
  entries: readonly SkipEntry[],
  send: (transactionId: string) => Promise<unknown>,
): Promise<SendOutcome> {
  const out: SendOutcome = { sent: [], dropped: [], retry: [] };
  for (const entry of entries) {
    try {
      await send(entry.item.transactionId);
      out.sent.push(entry);
    } catch (err) {
      (skipFailureKind(err) === 'retry' ? out.retry : out.dropped).push(entry);
    }
  }
  return out;
}
