/**
 * Display text for the wire enums the admin shows (user role and status, run
 * status, log level). The values themselves (`'failed'`, `'admin'`) stay the
 * identity used in comparisons and CSS classes; only what is rendered is translated.
 */
import { labels } from '@shared/i18n';

import { t } from './i18n';

export const ROLE_LABEL: Record<string, string> = labels(t, { user: 'role.user', admin: 'role.admin' });
export const USER_STATUS_LABEL: Record<string, string> = labels(t, {
  active: 'userStatus.active',
  disabled: 'userStatus.disabled',
});
export const RUN_STATUS_LABEL: Record<string, string> = labels(t, {
  queued: 'runStatus.queued',
  running: 'runStatus.running',
  succeeded: 'runStatus.succeeded',
  failed: 'runStatus.failed',
  cancelled: 'runStatus.cancelled',
});
export const LOG_LEVEL_LABEL: Record<string, string> = labels(t, {
  debug: 'logLevel.debug',
  info: 'logLevel.info',
  warn: 'logLevel.warn',
  error: 'logLevel.error',
});

/** The label for `value` in `table`, or the raw value for one this build does not know. */
export const label = (table: Record<string, string>, value: string): string => (Object.hasOwn(table, value) ? table[value] : value);
