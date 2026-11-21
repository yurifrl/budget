/**
 * Stored server sentences -> stable codes.
 *
 * `connections.status_message` and sync-run `user_message` hold English text
 * written by the server (a closed set, the constants below). Clients cannot
 * translate text, so reads add `status_message_code` / `user_message_code`
 * next to the unchanged text: the code of the exact matching constant, or null
 * for anything else (a sentence from an older build, a null message). No
 * migration; old rows work. The message for each code lives in the errors
 * catalog (`shared/src/i18n/errors`, keys `server_*`).
 */
import type { ServerMessageCode } from '@shared/errors';

import { JOB_USER_MESSAGES } from '../jobs';
import { PAUSE_MESSAGES, PAUSED_RUN_MESSAGE, USER_MESSAGES } from './errors';

/** Every stored sentence and its code. Exported for the round-trip test. */
export const SERVER_MESSAGES: readonly (readonly [ServerMessageCode, string])[] = [
  ['server_reconnect_bank', USER_MESSAGES.auth],
  ['server_quota_exhausted', USER_MESSAGES.quota_exhausted],
  ['server_rate_limited', USER_MESSAGES.rate_limited],
  ['server_transient', USER_MESSAGES.transient],
  ['server_permanent', USER_MESSAGES.permanent],
  ['server_paused_shared_keys', PAUSE_MESSAGES.shared],
  ['server_paused_own_keys', PAUSE_MESSAGES.own],
  ['server_run_paused', PAUSED_RUN_MESSAGE],
  ['server_cancelled_before_start', JOB_USER_MESSAGES.cancelledBeforeStart],
  ['server_cancelled', JOB_USER_MESSAGES.cancelled],
  ['server_job_failed', JOB_USER_MESSAGES.failed],
  ['server_job_unavailable', JOB_USER_MESSAGES.unavailable],
];

const CODE_BY_TEXT: ReadonlyMap<string, ServerMessageCode> = new Map(SERVER_MESSAGES.map(([code, text]) => [text, code]));

/** The code of a stored server sentence; null for null or unknown text (exact match only). */
export function serverMessageCode(text: string | null | undefined): ServerMessageCode | null {
  return text == null ? null : (CODE_BY_TEXT.get(text) ?? null);
}
