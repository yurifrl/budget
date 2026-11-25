/**
 * Pure logic of sending the rows held by the leave prompt: one request per
 * row, in order, and what is left when some fail (those stay for another try).
 */

import type { SkipEntry } from './accept.logic';

export interface SendOutcome {
  sent: SkipEntry[];
  failed: SkipEntry[];
}

/** Send every entry; a failure never stops the rest, and is reported with its entry. */
export async function sendEntries(
  entries: readonly SkipEntry[],
  send: (transactionId: string) => Promise<unknown>,
): Promise<SendOutcome> {
  const sent: SkipEntry[] = [];
  const failed: SkipEntry[] = [];
  for (const entry of entries) {
    try {
      await send(entry.item.transactionId);
      sent.push(entry);
    } catch {
      failed.push(entry);
    }
  }
  return { sent, failed };
}
